"""Build compact 2025 QB-to-skill-player chemistry data from nflverse PBP.

Run from the project root:
    python build_qb_synergy_data.py
"""
from __future__ import annotations

import gzip
import json
import math
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import urlretrieve

import pandas as pd


ROOT = Path(__file__).parent
# The development workspace keeps the published artifact under outputs/; the
# GitHub Pages checkout keeps the same files at its repository root.
OUT = ROOT / "outputs" / "qb_synergy_dashboard" if (ROOT / "outputs" / "qb_synergy_dashboard").exists() else ROOT
PBP_URL = "https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_2025.csv.gz"
PLAYERS_URL = "https://github.com/nflverse/nflverse-data/releases/download/players/players.csv"

# nflverse's primary player metadata position is defensive back for Travis Hunter,
# but targets recorded to him are receiver plays and belong in this dashboard.
RECEIVER_POSITION_OVERRIDES = {
    "00-0040718": "WR",  # Travis Hunter
}


def rate(row: pd.Series) -> float | None:
    att, comp, yards, td, ints = (row[k] for k in ("targets", "receptions", "yards", "td", "interceptions"))
    if not att:
        return None
    a = max(0, min(2.375, ((comp / att) - 0.3) * 5))
    b = max(0, min(2.375, ((yards / att) - 3) * 0.25))
    c = max(0, min(2.375, (td / att) * 20))
    d = max(0, min(2.375, 2.375 - (ints / att) * 25))
    return round(((a + b + c + d) / 6) * 100, 1)


def nullable(value, digits=1):
    if value is None or pd.isna(value) or math.isinf(value):
        return None
    return round(float(value), digits)


def canonical_name(names: pd.Series) -> str:
    """Keep one readable display name for each nflverse player ID."""
    candidates = [str(name) for name in names.dropna() if str(name).strip()]
    return max(candidates, key=lambda name: (len(name), name)) if candidates else "Unknown"


def main(scope: str = "REG", output_name: str = "data.json") -> None:
    playoff_scope = scope == "POST"
    OUT.mkdir(parents=True, exist_ok=True)
    cache = OUT / ".cache"
    cache.mkdir(exist_ok=True)
    pbp_file = cache / "play_by_play_2025.csv.gz"
    players_file = cache / "players.csv"
    if not pbp_file.exists():
        print("Downloading 2025 nflverse play-by-play…")
        urlretrieve(PBP_URL, pbp_file)
    if not players_file.exists():
        print("Downloading nflverse player metadata…")
        urlretrieve(PLAYERS_URL, players_file)

    cols = [
        "season_type", "week", "posteam", "passer_player_id", "passer_player_name",
        "receiver_player_id", "receiver_player_name",
        "pass_attempt", "complete_pass", "pass_touchdown", "interception", "first_down_pass",
        "passing_yards", "receiving_yards", "yards_after_catch", "air_yards", "epa", "success",
        "cpoe", "xyac_mean_yardage", "yardline_100", "down", "play_type", "qb_dropback",
    ]
    print("Reading and filtering play-by-play…")
    pbp = pd.read_csv(pbp_file, compression="gzip", usecols=cols, low_memory=False)
    players = pd.read_csv(players_file, low_memory=False)
    id_col = "gsis_id" if "gsis_id" in players.columns else "nfl_id"
    photo_col = next((c for c in ("headshot_url", "headshot") if c in players.columns), None)
    positions = dict(zip(players[id_col].astype(str), players["position"].fillna("")))
    positions.update(RECEIVER_POSITION_OVERRIDES)
    full_names = dict(zip(players[id_col].astype(str), players["display_name"].fillna("")))
    photos = dict(zip(players[id_col].astype(str), players[photo_col].fillna(""))) if photo_col else {}
    pbp["receiver_player_position"] = pbp.receiver_player_id.astype(str).map(positions)

    season_types = ["REG", "POST"] if scope == "ALL" else [scope]
    plays = pbp.loc[
        (pbp.season_type.isin(season_types))
        & (pbp.pass_attempt == 1)
        & pbp.passer_player_id.notna()
        & pbp.receiver_player_id.notna()
        & pbp.receiver_player_position.isin(["WR", "TE", "RB"])
    ].copy()
    plays["complete"] = plays.complete_pass.fillna(0)
    plays["yards"] = plays.receiving_yards.fillna(0)
    plays["yac"] = plays.yards_after_catch.fillna(0)
    plays["expected_yac"] = plays.xyac_mean_yardage.where(plays.complete.eq(1), 0).fillna(0)
    plays["td"] = plays.pass_touchdown.fillna(0)
    plays["ints"] = plays.interception.fillna(0)
    plays["first_down"] = plays.first_down_pass.fillna(0)
    plays["success_play"] = plays.success.fillna(0)
    plays["rz_target"] = (plays.yardline_100 <= 20).astype(int)
    plays["explosive"] = (plays.receiving_yards >= 20).astype(int)
    plays["money_down_target"] = plays.down.isin([3, 4]).astype(int)
    plays["money_down_failure"] = (
        plays.money_down_target.eq(1)
        & plays.first_down.eq(0)
        & plays.td.eq(0)
    ).astype(int)

    # Receiver IDs are canonical; nflverse occasionally changes the abbreviated name
    # within the same season (for example, C.Washington / Cas.Washington).
    canonical_receiver_names = plays.groupby(plays.receiver_player_id.astype(str))["receiver_player_name"].agg(canonical_name)
    plays["receiver_player_name"] = plays.receiver_player_id.astype(str).map(canonical_receiver_names)
    group = ["passer_player_id", "passer_player_name", "receiver_player_id", "receiver_player_position", "posteam"]
    pairs = plays.groupby(group, dropna=False).agg(
        receiver_player_name=("receiver_player_name", "first"),
        targets=("pass_attempt", "size"), receptions=("complete", "sum"), yards=("yards", "sum"),
        td=("td", "sum"), interceptions=("ints", "sum"), epa=("epa", "sum"),
        cpoe=("cpoe", "mean"), air_yards=("air_yards", "mean"), yac=("yac", "sum"), expected_yac=("expected_yac", "sum"),
        success_rate=("success_play", "mean"), first_downs=("first_down", "sum"),
        red_zone_targets=("rz_target", "sum"), money_down_targets=("money_down_target", "sum"),
        money_down_failures=("money_down_failure", "sum"),
        explosives=("explosive", "sum"), games=("week", "nunique"),
    ).reset_index()
    qb_totals = plays.groupby("passer_player_id").agg(
        qb_targets=("pass_attempt", "size"), qb_epa=("epa", "sum"),
        qb_red_zone_targets=("rz_target", "sum"),
        qb_money_down_targets=("money_down_target", "sum"),
    )
    receiver_totals = plays.groupby("receiver_player_id").agg(
        receiver_targets=("pass_attempt", "size"), receiver_epa=("epa", "sum"),
    )
    pairs = pairs.join(qb_totals, on="passer_player_id")
    pairs = pairs.join(receiver_totals, on="receiver_player_id")
    pairs["catch_rate"] = pairs.receptions / pairs.targets
    pairs["yards_per_target"] = pairs.yards / pairs.targets
    pairs["yards_per_reception"] = pairs.yards / pairs.receptions.replace(0, pd.NA)
    pairs["yac_per_reception"] = pairs.yac / pairs.receptions.replace(0, pd.NA)
    pairs["yac_over_expected"] = pairs.yac - pairs.expected_yac
    pairs["yac_over_expected_per_reception"] = pairs.yac_over_expected / pairs.receptions.replace(0, pd.NA)
    pairs["epa_per_target"] = pairs.epa / pairs.targets
    pairs["target_share"] = pairs.targets / pairs.qb_targets
    pairs["money_down_rate"] = pairs.money_down_targets / pairs.targets
    pairs["interception_rate"] = pairs.interceptions / pairs.targets
    pairs["money_down_failure_rate"] = pairs.money_down_failures / pairs.money_down_targets.replace(0, pd.NA)
    pairs["money_down_target_share"] = pairs.money_down_targets / pairs.qb_money_down_targets.replace(0, pd.NA)
    pairs["red_zone_target_share"] = pairs.red_zone_targets / pairs.qb_red_zone_targets.replace(0, pd.NA)
    pairs["money_down_share_lift"] = pairs.money_down_target_share - pairs.target_share
    pairs["red_zone_share_lift"] = pairs.red_zone_target_share - pairs.target_share
    qb_other_targets = (pairs.qb_targets - pairs.targets).replace(0, pd.NA)
    pairs["qb_other_epa_per_target"] = (pairs.qb_epa - pairs.epa) / qb_other_targets
    pairs["qb_epa_lift"] = pairs.epa_per_target - pairs.qb_other_epa_per_target

    weekly_group = ["week", *group]
    weekly = plays.groupby(weekly_group, dropna=False).agg(
        targets=("pass_attempt", "size"), receptions=("complete", "sum"), epa=("epa", "sum"), cpoe=("cpoe", "mean"),
        success_rate=("success_play", "mean"), first_downs=("first_down", "sum"),
        red_zone_targets=("rz_target", "sum"), money_down_targets=("money_down_target", "sum"),
        money_down_failures=("money_down_failure", "sum"), explosives=("explosive", "sum"),
        interceptions=("ints", "sum"), yac=("yac", "sum"), expected_yac=("expected_yac", "sum"),
    ).reset_index()
    weekly_qb = plays.groupby(["week", "passer_player_id"]).agg(
        qb_targets=("pass_attempt", "size"), qb_epa=("epa", "sum"),
        qb_red_zone_targets=("rz_target", "sum"), qb_money_down_targets=("money_down_target", "sum"),
    ).reset_index()
    weekly = weekly.merge(weekly_qb, on=["week", "passer_player_id"], how="left")
    weekly["epa_per_target"] = weekly.epa / weekly.targets
    weekly["yac_over_expected_per_reception"] = (weekly.yac - weekly.expected_yac) / weekly.receptions.replace(0, pd.NA)
    weekly["target_share"] = weekly.targets / weekly.qb_targets
    weekly["money_down_share_lift"] = (
        weekly.money_down_targets / weekly.qb_money_down_targets.replace(0, pd.NA)
        - weekly.target_share
    )
    weekly["red_zone_share_lift"] = (
        weekly.red_zone_targets / weekly.qb_red_zone_targets.replace(0, pd.NA)
        - weekly.target_share
    )
    weekly_other_targets = (weekly.qb_targets - weekly.targets).replace(0, pd.NA)
    weekly["qb_epa_lift"] = weekly.epa_per_target - (weekly.qb_epa - weekly.epa) / weekly_other_targets
    weekly["interception_rate"] = weekly.interceptions / weekly.targets
    weekly["money_down_failure_rate"] = weekly.money_down_failures / weekly.money_down_targets.replace(0, pd.NA)
    weekly_keys = ["targets", "epa_per_target", "cpoe", "yac_over_expected_per_reception", "success_rate", "first_downs", "explosives", "target_share", "money_down_share_lift", "red_zone_share_lift", "qb_epa_lift", "qb_money_down_targets", "qb_red_zone_targets", "interception_rate", "money_down_failure_rate"]
    def pair_key(row):
        return tuple(str(row[column]) for column in group)
    weekly_by_pair = {}
    for row in weekly.to_dict("records"):
        weekly_by_pair.setdefault(pair_key(row), []).append({
            "week": int(row["week"]),
            **{key: nullable(row[key], 3) for key in weekly_keys},
        })

    recent = plays.loc[plays.week >= plays.week.max() - 3]
    last4 = recent.groupby(group, dropna=False).agg(
        last4_targets=("pass_attempt", "size"), last4_receptions=("complete", "sum"), last4_epa=("epa", "sum"),
        last4_cpoe=("cpoe", "mean"), last4_success_rate=("success_play", "mean"),
        last4_first_downs=("first_down", "sum"), last4_red_zone_targets=("rz_target", "sum"),
        last4_money_down_targets=("money_down_target", "sum"),
        last4_money_down_failures=("money_down_failure", "sum"),
        last4_explosives=("explosive", "sum"), last4_interceptions=("ints", "sum"), last4_yac=("yac", "sum"), last4_expected_yac=("expected_yac", "sum"),
        last4_games=("week", "nunique"),
    ).reset_index()
    last4_qb = recent.groupby("passer_player_id").agg(
        last4_qb_targets=("pass_attempt", "size"), last4_qb_epa=("epa", "sum"),
        last4_qb_red_zone_targets=("rz_target", "sum"),
        last4_qb_money_down_targets=("money_down_target", "sum"),
    )
    last4 = last4.join(last4_qb, on="passer_player_id")
    last4["last4_epa_per_target"] = last4.last4_epa / last4.last4_targets
    last4["last4_yac_over_expected_per_reception"] = (last4.last4_yac - last4.last4_expected_yac) / last4.last4_receptions.replace(0, pd.NA)
    last4["last4_target_share"] = last4.last4_targets / last4.last4_qb_targets
    last4["last4_money_down_target_share"] = last4.last4_money_down_targets / last4.last4_qb_money_down_targets.replace(0, pd.NA)
    last4["last4_red_zone_target_share"] = last4.last4_red_zone_targets / last4.last4_qb_red_zone_targets.replace(0, pd.NA)
    last4["last4_money_down_share_lift"] = (
        last4.last4_money_down_targets / last4.last4_qb_money_down_targets.replace(0, pd.NA)
        - last4.last4_target_share
    )
    last4["last4_red_zone_share_lift"] = (
        last4.last4_red_zone_targets / last4.last4_qb_red_zone_targets.replace(0, pd.NA)
        - last4.last4_target_share
    )
    last4_other_targets = (last4.last4_qb_targets - last4.last4_targets).replace(0, pd.NA)
    last4["last4_qb_epa_lift"] = last4.last4_epa_per_target - (last4.last4_qb_epa - last4.last4_epa) / last4_other_targets
    last4["last4_money_down_failure_rate"] = last4.last4_money_down_failures / last4.last4_money_down_targets.replace(0, pd.NA)
    last4["last4_interception_rate"] = last4.last4_interceptions / last4.last4_targets
    recent_columns = [c for c in last4.columns if c.startswith("last4_")]
    pairs = pairs.merge(last4[group + recent_columns], on=group, how="left")
    pairs[recent_columns] = pairs[recent_columns].apply(pd.to_numeric, errors="coerce").fillna(0)
    pairs["passer_rating"] = pairs.apply(rate, axis=1)
    pairs = pairs.loc[pairs.targets >= 2].sort_values(["passer_player_name", "targets"], ascending=[True, False])

    numeric = ["targets", "receptions", "yards", "td", "interceptions", "epa", "cpoe", "air_yards", "yac", "expected_yac", "yac_over_expected", "yac_over_expected_per_reception", "success_rate", "first_downs", "red_zone_targets", "money_down_targets", "money_down_failures", "explosives", "games", "qb_targets", "qb_epa", "qb_red_zone_targets", "qb_money_down_targets", "receiver_targets", "receiver_epa", "catch_rate", "yards_per_target", "yards_per_reception", "yac_per_reception", "epa_per_target", "target_share", "money_down_rate", "interception_rate", "money_down_failure_rate", "money_down_target_share", "red_zone_target_share", "money_down_share_lift", "red_zone_share_lift", "qb_other_epa_per_target", "qb_epa_lift", "passer_rating", *recent_columns]
    records = []
    for r in pairs.to_dict("records"):
        item = {
            "qbId": str(r["passer_player_id"]), "qb": r["passer_player_name"],
            "qbFullName": full_names.get(str(r["passer_player_id"]), r["passer_player_name"]),
            "receiverId": str(r["receiver_player_id"]), "receiver": r["receiver_player_name"],
            "receiverFullName": full_names.get(str(r["receiver_player_id"]), r["receiver_player_name"]),
            "position": r["receiver_player_position"], "team": r["posteam"],
            "qbPhoto": photos.get(str(r["passer_player_id"]), ""),
            "receiverPhoto": photos.get(str(r["receiver_player_id"]), ""),
            # Weekly history is retained for score-qualified connections; this keeps
            # the public payload compact without changing rankings or raw totals.
            "weekly": weekly_by_pair.get(pair_key(r), []) if r["targets"] >= (5 if playoff_scope else 15) else [],
        }
        for key in numeric:
            item[key] = nullable(r[key], 3 if key in {"epa", "cpoe", "air_yards", "expected_yac", "yac_over_expected", "yac_over_expected_per_reception", "epa_per_target", "target_share", "money_down_rate", "interception_rate", "money_down_failure_rate", "money_down_target_share", "red_zone_target_share", "money_down_share_lift", "red_zone_share_lift", "qb_other_epa_per_target", "qb_epa_lift", "success_rate", "catch_rate"} or key.startswith("last4_") else 1)
        records.append(item)
    identity_audit = pd.DataFrame(records).groupby("receiverId")["receiver"].nunique()
    conflicts = identity_audit[identity_audit > 1]
    if not conflicts.empty:
        raise ValueError(f"Receiver identity audit failed for IDs: {', '.join(conflicts.index.tolist())}")
    print(f"Identity audit passed: {len(identity_audit):,} receiver IDs each have one display name.")
    scope_label = {
        "REG": "Regular season",
        "POST": "Playoffs",
        "ALL": "Regular season + playoffs",
    }[scope]
    playoff_scope = scope == "POST"
    payload = {
        "season": 2025,
        "scope": f"{scope_label} · receiver-tagged pass attempts",
        "seasonScope": scope,
        "generatedAt": datetime.now(timezone.utc).date().isoformat(),
        "methodVersion": "2025.1",
        # Short playoff schedules need smaller, but still meaningful, samples.
        "thresholds": {
            "score": 5 if playoff_scope else 15,
            "qualified": 5 if playoff_scope else 30,
            "weekly": 2 if playoff_scope else 4,
        },
        "pairs": records,
    }
    output_path = OUT / output_name
    output_path.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    print(f"Wrote {len(records):,} QB–receiver pair rows to {output_path}")


if __name__ == "__main__":
    main("REG", "data.json")
    main("POST", "data-playoffs.json")
    main("ALL", "data-combined.json")
