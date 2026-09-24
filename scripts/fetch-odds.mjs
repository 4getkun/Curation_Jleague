// 姉妹サイト「J1順位確率早見表」(https://fourgetkun.com/j1-odds/)の最新の計算結果を取得し、
// クラブページの「今季の見通し」に必要な項目だけを src/data/odds-j1.json に保存する。
//
// - 取得に失敗した場合は、前回の odds-j1.json をそのまま残して正常終了する
//   (見通しが少し古くなるだけで、ニュースの更新・公開は止めない)
// - teams.json の oddsId と、確率サイトの今季のクラブが食い違っていたら警告を出す
//   (昇格・降格でクラブが入れ替わった後に、teams.json の更新漏れに気づけるように)
import { readFile, writeFile } from "node:fs/promises";

const SOURCE = "https://fourgetkun.com/j1-odds/data/odds.json";
const OUT = new URL("../src/data/odds-j1.json", import.meta.url);
const TEAMS = new URL("../src/data/teams.json", import.meta.url);

function warn(msg) {
  // GitHub Actions の注釈として表示される
  console.log(`::warning::${msg}`);
}

async function main() {
  let d;
  try {
    const res = await fetch(SOURCE, { signal: AbortSignal.timeout(20000), headers: { "cache-control": "no-cache" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    d = await res.json();
  } catch (e) {
    warn(`J1順位確率の取得に失敗したため、前回のデータを使います: ${e.message}`);
    return;
  }
  if (d.schema_version !== 1 || !Array.isArray(d.teams) || d.teams.length !== 20) {
    warn("J1順位確率のデータ形式が想定と違うため、前回のデータを使います");
    return;
  }

  const teams = JSON.parse(await readFile(TEAMS, "utf8"));
  const mine = new Set(teams.map((t) => t.oddsId));
  const theirs = new Set(d.teams.map((t) => t.team_id));
  const missing = [...theirs].filter((id) => !mine.has(id));
  const extra = [...mine].filter((id) => !theirs.has(id));
  if (missing.length || extra.length) {
    warn(`teams.json と今季のJ1のクラブが食い違っています(teams.jsonに無い: ${missing.join(",") || "なし"} / 今季J1に無い: ${extra.join(",") || "なし"})`);
  }

  const out = {
    source: "https://fourgetkun.com/j1-odds/",
    data_as_of: d.data_as_of,
    matches_played: d.matches_played,
    matches_total: d.matches_total,
    trials: d.trials,
    teams: Object.fromEntries(
      d.teams.map((t) => [
        t.team_id,
        {
          rank: t.current.rank,
          points: t.current.points,
          played: t.current.played,
          gd: t.current.gd,
          probs: { champion: t.probs.champion, acle_direct: t.probs.acle_direct, relegation: t.probs.relegation },
          status: { champion: t.status.champion, acle_direct: t.status.acle_direct, relegation: t.status.relegation },
          expected_rank: t.expected_rank,
          rank_change_7d: t.change ? t.change.expected_rank : null,
        },
      ]),
    ),
    upcoming: d.upcoming.map((m) => ({
      date: m.date, kickoff: m.kickoff, home_id: m.home_id, away_id: m.away_id,
      home_name: m.home_name, away_name: m.away_name, p_home: m.p_home, p_draw: m.p_draw, p_away: m.p_away,
    })),
  };
  const text = JSON.stringify(out, null, 2) + "\n";
  let prev = "";
  try { prev = await readFile(OUT, "utf8"); } catch {}
  if (prev === text) {
    console.log("J1順位確率: 変化なし");
    return;
  }
  await writeFile(OUT, text);
  console.log(`J1順位確率: ${d.data_as_of}時点のデータを保存しました`);
}

main();
