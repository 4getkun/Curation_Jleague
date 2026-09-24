import teamsData from "../data/teams.json";

export interface Team {
  id: string;
  row: 1 | 2 | 3 | 4;
  name: string;
  short: string;
  /** 英語表記(欧文キッカー・ヒーロー見出し等のデザイン要素で使用) */
  en: string;
  shortKeywords: string[];
  strongKeywords: string[];
  color: string;
  /** 姉妹サイト「J1順位確率早見表」でのクラブID(今季の見通しカード用。scripts/fetch-odds.mjs 参照) */
  oddsId?: string;
}

export const teams: Team[] = teamsData as Team[];

export const teamsById: Record<string, Team> = Object.fromEntries(
  teams.map((t) => [t.id, t]),
);

// J1は20クラブと多いため、NPB/MLBの2行(セ/パ、ア/ナ)ではなくヘッダーの
// クイックナビを4行×5クラブのグリッドにしている。行番号は大まかな地域
// (関東・首都圏/近畿以西 等)でまとめたもので、厳密なJリーグの公式区分では
// ない(そもそもJ1自体に東西カンファレンス等の区分はない)。
export const teamRows: Team[][] = [1, 2, 3, 4].map((row) =>
  teams.filter((t) => t.row === row),
);

export function getTeam(id: string): Team | undefined {
  return teamsById[id];
}

// 明るいクラブカラー(黄色系など)の上に白文字を乗せると読めなくなるため、
// バッジ・チップの文字色をカラーごとに出し分ける。デザインハンドオフ
// (design_handoff_jleague_redesign)で指定されたクラブカラーのうち、
// 相対輝度が0.55を超えるもの(柏・ジェフ千葉・川崎F・清水・長崎)を対象にしている。
const LIGHT_TEAM_COLORS = new Set(["#F2C900", "#EDD000", "#33B4E4", "#F08300", "#F39800"]);

export function textOnTeamColor(color: string): string {
  return LIGHT_TEAM_COLORS.has(color) ? "#1b263b" : "#ffffff";
}

// ほぼ黒/極端に暗い球団カラーは、ダークモードの背景と同化して見えなく
// なるため、色ドット・色スクエアにだけ細いリングを足す。
export function needsContrastRing(color: string): boolean {
  const hex = color.replace("#", "");
  if (hex.length !== 6) return false;
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luminance < 0.15;
}
