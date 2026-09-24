// 姉妹サイト「J1順位確率早見表」の計算結果(scripts/fetch-odds.mjs が保存した src/data/odds-j1.json)を
// クラブページの「今季の見通し」カードで使う形にする。
import oddsData from "../data/odds-j1.json";
import type { Team } from "./teams";

export const ODDS_SITE_URL = "/j1-odds/";
export const ODDS_METHOD_URL = "/j1-odds/explainer/methodology";

type Status = "clinched" | "eliminated" | null;

interface OddsTeam {
  rank: number;
  points: number;
  played: number;
  gd: number;
  probs: { champion: number; acle_direct: number; relegation: number };
  status: { champion: Status; acle_direct: Status; relegation: Status };
  expected_rank: number;
  rank_change_7d: number | null;
}

interface Upcoming {
  date: string;
  kickoff: string;
  home_id: string;
  away_id: string;
  home_name: string;
  away_name: string;
  p_home: number;
  p_draw: number;
  p_away: number;
}

interface OddsFile {
  data_as_of: string;
  matches_played: number;
  matches_total: number;
  trials: number;
  teams: Record<string, OddsTeam>;
  upcoming: Upcoming[];
}

const odds = oddsData as unknown as OddsFile;

export interface NextMatch {
  date: string;
  kickoff: string;
  opponent: string;
  home: boolean;
  win: number;
  draw: number;
  lose: number;
}

export interface TeamOutlook extends OddsTeam {
  dataAsOf: string;
  matchesPlayed: number;
  trials: number;
  next: NextMatch | null;
}

export function outlookForTeam(team: Team): TeamOutlook | null {
  const t = team.oddsId ? odds.teams?.[team.oddsId] : undefined;
  if (!t) return null;
  const m = odds.upcoming?.find((u) => u.home_id === team.oddsId || u.away_id === team.oddsId);
  const next: NextMatch | null = m
    ? m.home_id === team.oddsId
      ? { date: m.date, kickoff: m.kickoff, opponent: m.away_name, home: true, win: m.p_home, draw: m.p_draw, lose: m.p_away }
      : { date: m.date, kickoff: m.kickoff, opponent: m.home_name, home: false, win: m.p_away, draw: m.p_draw, lose: m.p_home }
    : null;
  return { ...t, dataAsOf: odds.data_as_of, matchesPlayed: odds.matches_played, trials: odds.trials, next };
}

/** 0〜1の確率を「23.4%」の形に。ごく小さい値は「<0.1%」 */
export function pct(p: number, digits = 1): string {
  if (p === 0) return "0%";
  if (p === 1) return "100%";
  if (p < 0.001) return "<0.1%";
  if (p > 0.999) return ">99.9%";
  return `${(p * 100).toFixed(digits)}%`;
}

export const STATUS_TEXT: Record<"champion" | "acle_direct" | "relegation", Record<"clinched" | "eliminated", string>> = {
  champion: { clinched: "優勝決定", eliminated: "可能性なし" },
  acle_direct: { clinched: "確定", eliminated: "可能性なし" },
  relegation: { clinched: "降格決定", eliminated: "残留確定" },
};

/** "2026-10-09" → "10/9(金)" */
export function dateJa(iso: string): string {
  const d = new Date(`${iso}T00:00:00+09:00`);
  const w = "日月火水木金土"[new Date(d.getTime() + 9 * 3600 * 1000).getUTCDay()];
  return `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}(${w})`;
}
