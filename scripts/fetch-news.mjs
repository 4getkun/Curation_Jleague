// scripts/fetch-news.mjs
//
// Jリーグ(J1)ニュース自動収集スクリプト。
// GitHub Actions (.github/workflows/update-news.yml) から定期実行され、
// 各RSSフィードを取得 → J1全20クラブに分類 → 重複排除 → 新しい順に並べて
// src/data/news.json に書き出す。
//
// このリポジトリは静的サイト(GitHub Pages)なのでサーバーは動かせない。
// 代わりに「ビルド時点の最新ニュース」をこのJSONに固定し、Astroが
// 静的HTMLとして出力する。定期的にこのスクリプト→ビルド→デプロイを
// 繰り返すことで疑似リアルタイム更新を実現する。
//
// 収集した記事は「タイトル・要約・リンク・出典」のみを保持し、本文は
// 一切コピーしない（著作権に配慮し、参照元サイトへ送客する設計）。
//
// このファイルの分類ロジックは、姉妹サイト「Curation NPB」の
// fetch-news.mjsで実運用しながら積み上げた知見(曖昧な略称の文脈判定・
// 対戦相手としての言及の除外・全角/半角の正規化・他競技の混入除外等)を
// そのまま移植したもの。ただしNPB固有の定型記事パターン(登録抹消の
// 「◯日公示」等)は、Jリーグの実データで確認が取れるまでは追加せず、
// 汎用的な「該当クラブ数が一定以上なら総合タグ扱い」という安全網
// (ROUNDUP_TEAM_COUNT_THRESHOLD)だけを設けている。実データで新たな
// 定型パターンや誤爆が見つかり次第、NPB版と同じ要領で個別に追加していく。

import Parser from "rss-parser";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const TEAMS = JSON.parse(
  await readFile(path.join(ROOT, "src/data/teams.json"), "utf-8"),
);
const FEEDS = JSON.parse(
  await readFile(path.join(ROOT, "src/data/feeds.json"), "utf-8"),
);
const TOPICS = JSON.parse(
  await readFile(path.join(ROOT, "src/data/topics.json"), "utf-8"),
);

const OUTPUT_PATH = path.join(ROOT, "src/data/news.json");
// RSSは「今取れる最新N件」しか返さない(=フィード側に過去ログは残っていない)。
// そのため実行のたびに取得結果を過去のnews.jsonへ積み増し(マージ)し、
// 直近RETENTION_DAYS日分をローリングウィンドウとして保持する。
// GitHub Actionsが30分おきにこのスクリプト→コミットを繰り返すことで、
// 運用開始からおよそ1ヶ月かけて手元のアーカイブが積み上がっていく。
const RETENTION_DAYS = 30;
const MAX_ITEMS = 4000; // 保険用の上限(想定件数を大きく超えないよう安全弁として設定)
const MAX_PER_FEED = 60;
// GitHub Actionsのランナー(データセンターのIP)からだと、フィードによっては
// 手元の検証環境より応答が遅く、以前デフォルトの15秒では間に合わずタイム
// アウトすることがあった。全フィードはPromise.allで並列取得しているため、
// この値を上げても他フィードの合計取得時間には影響しない(一番遅い1本の
// 秒数が効くだけ)ので、余裕を持たせている。
const FETCH_TIMEOUT_MS = 30000;
const FEED_RETRY_COUNT = 1; // タイムアウト等の一時的な失敗に備え、1回だけ再試行する
const FEED_RETRY_DELAY_MS = 2000;

// 「同一ニュースの重複統合」機能のしきい値。複数メディアが同じ出来事を
// 報じた記事を1件にまとめて表示するための判定パラメータ。
// 精度(=誤って別の出来事をまとめてしまわないこと)を優先し、かなり保守的な
// 値にしている。クラブタグが1つも重ならない記事同士や、日付不明な記事同士は
// そもそも統合対象にしない。
const DEDUPE_TITLE_SIMILARITY = 0.6; // タイトルの2文字Jaccard類似度のしきい値
const DEDUPE_WINDOW_MS = 4 * 60 * 60 * 1000; // 公開時刻の差がこの範囲内のみ統合対象

// 記事がJリーグ(J1)関連かどうかの判定に使う一般キーワード
// (クラブ名にマッチしなくても、これらを含めばJリーグ全般ニュースとして採用)
const GENERAL_JLEAGUE_KEYWORDS = [
  "Jリーグ",
  "J1",
  "J1リーグ",
  "明治安田J1リーグ",
  "明治安田生命Jリーグ",
  "ACL",
  "ACLエリート",
  "ACLツー",
  "天皇杯",
  "ルヴァンカップ",
  "YBCルヴァンカップ",
];

// このサイトはJリーグ(J1)全20クラブを対象とするサイトなので、同じ
// 「サッカー」でも対象外のカテゴリはクラブ名にヒットしていても記事ごと
// 除外する(例:「大学サッカー」の記事がクラブ名の地名と偶然一致して
// 誤判定されるのを防ぐ)。なでしこリーグ・WEリーグは女子サッカーの別リーグ、
// フットサルは別競技なので、いずれも対象外として除外する。
const OUT_OF_SCOPE_KEYWORDS = [
  "高校サッカー",
  "高校選手権",
  "全国高校サッカー選手権",
  "大学サッカー",
  "インカレ",
  "なでしこリーグ",
  "WEリーグ",
  "なでしこジャパン",
  "なでしこ",
  // 「浦和レッズレディース」「日テレ・東京ヴェルディレディース」のように、
  // 男子J1クラブの女子アフィリエイトチームは同じクラブ名を含むため、
  // 「浦和レッズ」等のstrongKeywordsが女子サッカーの記事にも誤ヒットして
  // しまう(実データで「アルビレックス新潟レディース」の移籍記事が浦和
  // レッズタグに誤って表示される事例を確認)。「レディース」は男子トップ
  // チームの記事では基本的に使われない語なので、記事ごと除外する。
  "レディース",
  "フットサル",
  "少年サッカー",
];

// クラブの略称は「浦和」「柏」「千葉」「広島」のように、地名・企業名・
// 一般名詞としても使われる曖昧な単語が多い。始球式に類する来場イベントや
// マスコット登場などをきっかけに、サッカーそのものとはほぼ無関係な芸能・
// エンタメ系の記事(アイドルのファンミーティング等)がクラブ名にヒットして
// 紛れ込むことがあるため、そうした記事はサッカー関連キーワードの有無に
// 関わらず除外する。
const ENTERTAINMENT_NOISE_KEYWORDS = [
  "始球式",
  "始蹴式",
  "始球式・始蹴式",
  "ファンミーティング",
  "舞台挨拶",
  "来日公演",
  "主演",
  "ドラマ化",
  "映画化",
  "K-POP",
  "Kポップ",
  "韓流",
  "アイドル",
  "AKB48",
  "乃木坂46",
  "欅坂46",
  "日向坂46",
  "櫻坂46",
  "NMB48",
  "HKT48",
  "SKE48",
];

function isEntertainmentNoise(haystack) {
  return ENTERTAINMENT_NOISE_KEYWORDS.some((kw) => haystack.includes(kw));
}

// このサイトはJリーグ(J1)専門なので、総合スポーツフィード経由で紛れ込む
// 他競技の記事(野球・ゴルフ・相撲等)は、クラブ名にヒットしていても除外
// する。特に姉妹サイト「Curation NPB」の運用で、NPB球団の略称・愛称と
// Jリーグクラブの地名(「広島」＝カープ/サンフレッチェ、「横浜」＝DeNA/
// マリノス等)が衝突する事例が複数確認されているため、プロ野球関連の
// キーワードは重点的に含めている(このサイト自身のクラブ名の中にも
// 「浦和」「柏」「千葉」「広島」「神戸」のような地名ベースの曖昧な
// shortKeywordsが含まれるため、プロ野球記事側からの誤ヒットを防ぐ意味でも
// 重要)。
const OTHER_SPORTS_KEYWORDS = [
  "野球",
  "プロ野球",
  "NPB",
  "高校野球",
  "甲子園",
  "大学野球",
  "独立リーグ",
  "MLB",
  "大リーグ",
  "メジャーリーグ",
  // 「野球」「プロ野球」という単語自体を含まないNPB記事(実況・結果速報系の
  // 見出しに多い)がある。実データで「【広島】今季初先発のアドゥワ…」
  // (広島東洋カープの投手成績を報じる記事)がクラブ名「広島」(サンフレッチェ
  // 広島のshortKeyword)に誤ヒットする事例を確認した。「投手」「安打」
  // 「本塁打」「防御率」「完投」「無安打」「四球」「死球」はいずれも野球
  // 特有の統計・用語でサッカー記事にはまず出てこないため、カテゴリ除外の
  // 手がかりとして追加している。あわせてNPB球団の本拠地球場名(サッカーの
  // スタジアム名とは呼称が明確に異なる)も強いシグナルとして使える。
  "投手",
  "安打",
  "本塁打",
  "防御率",
  "完投",
  "無安打",
  "四球",
  "死球",
  "マツダスタジアム",
  "バンテリンドーム",
  "京セラドーム",
  "エスコンフィールド",
  "ベルーナドーム",
  "ZOZOマリン",
  "女子ゴルフ",
  "男子ゴルフ",
  "ゴルフ",
  "テニス",
  "バレーボール",
  "バスケットボール",
  "NBA",
  "Bリーグ",
  "NFL",
  "アメリカンフットボール",
  "アメフト",
  "ラグビー",
  "卓球",
  "大相撲",
  "競馬",
  "JRA",
  "新馬",
  "栗東",
  "美浦",
  "ボクシング",
  "フィギュアスケート",
  "eスポーツ",
];

function isOtherSportsContent(haystack) {
  return OTHER_SPORTS_KEYWORDS.some((kw) => haystack.includes(kw));
}

// Yahoo!ニュース経由のRSSは、見出し末尾に配信元メディア名を
// 「(◯◯スポーツ)」のように括弧書きで必ず付与してくる。この出典表記は
// 表示上は有用だが、分類用のテキストにそのまま含めると、メディア名が
// たまたまクラブの略称と一致するケースで、記事内容とは無関係にクラブ
// タグが付いてしまう。分類・除外判定用のテキストからはこの末尾の
// 括弧書きを取り除く(保存・表示用のtitleそのものは変更しない)。
function stripTrailingSourceSuffix(title) {
  return title.replace(/[（(][^（）()]*[）)]\s*$/, "").trim();
}

// 見出し・本文には「Ｊリーグ」「１７日」のように全角英数記号が使われる
// ことがある一方、各キーワードリストは半角で統一しているため、そのままでは
// 一致しない。分類・除外判定の直前に全角英数記号だけを半角へ正規化する
// (表示用のtitle/summary自体は変更しない)。normalizeTitleForCompare内の
// 重複統合用正規化と同じ変換(全角英数記号の範囲！-～をコードポイント
// 0xFEE0分だけ引いて半角化)を流用している。
function normalizeWidthForMatching(text) {
  return text.replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
}

// stage2(タイトルのみ・一般Jリーグ文脈チェックなしの緩和判定)で、
// shortKeywords(曖昧な略称)を無条件でヒット扱いにしてしまうと、「柏市で
// イベント開催」のような地名としての言及まで拾ってしまう。GENERAL_JLEAGUE_
// KEYWORDSほど大掛かりでなくても、見出しに実際の試合展開・選手動向を示す
// 語彙が含まれていれば、それを「緩和条件下でのサッカー文脈」とみなす。
const JLEAGUE_ACTION_KEYWORDS = [
  "先発",
  "スタメン",
  "先発出場",
  "途中出場",
  "途中出場",
  "ゴール",
  "得点",
  "アシスト",
  "PK",
  "ＰＫ",
  "オウンゴール",
  "イエローカード",
  "レッドカード",
  "退場",
  "交代",
  "監督",
  "コーチ",
  "采配",
  "移籍",
  "期限付き移籍",
  "完全移籍",
  "レンタル移籍",
  "契約更改",
  "契約延長",
  "年俸",
  "戦力外",
  "自由契約",
  "優勝",
  "連覇",
  "首位",
  "降格",
  "昇格",
  "J1昇格",
  "快勝",
  "逆転",
  "サヨナラ",
  "完封",
  "クリーンシート",
  "無失点",
  "失点",
  "開幕戦",
  "勝ち点",
  "負傷",
  "離脱",
  "手術",
];

function matchesSoccerAction(text) {
  return JLEAGUE_ACTION_KEYWORDS.some((kw) => text.includes(kw));
}

// 「広告ゼロ」を掲げているサイトなので、タイアップ・PR記事(スポンサード
// コンテンツ)は取得元フィードに含まれていても除外する。
const AD_MARKERS = [
  "【PR】",
  "[PR]",
  "(PR)",
  "（PR）",
  "ＰＲ】",
  "PR)",
  "PR】",
];

function isAdContent(title) {
  const upper = title.toUpperCase();
  return AD_MARKERS.some((marker) => upper.includes(marker.toUpperCase()));
}

// 「元Jリーガーが実業家に転身した」的な経歴紹介・インタビュー記事は、
// 記事本文に強いキーワード(クラブの正式名称等)が出典表記として出てくる
// ことが多く、現役選手のJリーグニュースと誤ってクラブタグ付けされて
// しまう。ただし「引退」「転身」単体は、実際には「攻撃的MFから守備的MFに
// 転身」のような現役選手の現役続行ニュースでも普通に使われる語彙なので、
// 単独のキーワードとして除外リストに入れるのはリスクが高い(=他記事を
// 巻き込む)。
//
// そのため、ここだけは「元選手であることを示す語彙」と「経営者になった
// ことを示す語彙」の両方が同時に含まれている場合のみ除外する、という
// AND条件にしている。ビジネス系の実業家インタビュー記事はこの組み合わせが
// ほぼ確実に揃う一方、実際の試合展開・移籍ニュースの記事にこの組み合わせが
// 偶然揃うことはまず無いため、他の除外リストより誤爆リスクを抑えられる。
const FORMER_PLAYER_SIGNALS = [
  "元Jリーガー",
  "元プロサッカー選手",
  "サッカー選手から転身",
  "現役引退後",
  "引退後は",
];

const EXECUTIVE_CAREER_SIGNALS = [
  "代表取締役",
  "経営者",
  "社長に",
  "起業",
  "会社を設立",
];

function isRetiredPlayerBusinessProfile(haystack) {
  const hasFormerPlayerSignal = FORMER_PLAYER_SIGNALS.some((kw) => haystack.includes(kw));
  if (!hasFormerPlayerSignal) return false;
  return EXECUTIVE_CAREER_SIGNALS.some((kw) => haystack.includes(kw));
}

const parser = new Parser({
  timeout: FETCH_TIMEOUT_MS,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (compatible; JLeagueCurationBot/1.0; +https://github.com/4getkun/Curation_Jleague)",
  },
});

/** keywords それぞれがテキスト中に出現する [開始位置, 終了位置) を全て返す */
function findAllSpans(scanText, keywords) {
  const spans = [];
  for (const kw of keywords) {
    let searchFrom = 0;
    while (searchFrom <= scanText.length) {
      const idx = scanText.indexOf(kw, searchFrom);
      if (idx === -1) break;
      spans.push([idx, idx + kw.length]);
      searchFrom = idx + kw.length;
    }
  }
  return spans;
}

// 「浦和―柏」「浦和-柏」「浦和vs柏」のような対戦カード表記で使われる
// 区切り文字。長音記号(ー)も見出しでは簡易的なダッシュとして使われることが
// 多いため含めている。
const MATCHUP_SEPARATORS = ["―", "—", "–", "－", "ー", "-", "対", "vs", "VS", "ｖｓ"];

// 全クラブの正式名称・略称をまとめたもの(対戦カード表記の判定で、区切り文字の
// 反対側が「別のクラブ名」かどうかを調べるために使う)。TEAMSはこのファイルの
// 先頭で読み込み済みのモジュールスコープ変数。
const ALL_TEAM_KEYWORDS = TEAMS.flatMap((t) => [...t.strongKeywords, ...t.shortKeywords]);

/**
 * scanText中のidx位置にある(長さkwLengthの)クラブ名言及が、「クラブA・区切り
 * 文字・クラブB」形式の対戦カード表記(例:「浦和―柏」「浦和vs柏」)の一部として
 * 登場しているかどうかを判定する。
 *
 * 試合結果・試合前情報系の記事では、見出しの冒頭やリード文に必ず
 * 「◇J1第20節 浦和―柏（日付、埼玉）」のような対戦カード表記が入る。
 * これは「◯◯戦」と同じく対戦相手としての言及であり、この表記の中にしか
 * 出てこないクラブは記事の主役ではない(=対戦相手として本拠地表記になって
 * いるだけ、等)とみなして除外する。
 */
// 「浦和3―1柏（2026年7月16日 埼玉）」のように、対戦カード表記の区切り文字の
// 両側に得点(1〜3桁)が挟まる試合結果見出しのパターン。区切り文字がクラブ名に
// 直接隣接しないため、MATCHUP_SEPARATORSの単純な前後一致だけでは検出できず、
// この形式の記事が対戦相手側のタブにも誤って表示される不具合が(姉妹サイト
// Curation NPBで)確認されたため追加した。
const SCORE_GAP_AFTER_RE = /^\d{1,3}\s*[―—–－ー-]\s*\d{1,3}/;
const SCORE_GAP_BEFORE_RE = /\d{1,3}\s*[―—–－ー-]\s*\d{1,3}$/;

// 「◯◯のエース〇〇を打ち崩し」のような、対戦相手クラブのエース級選手を
// 抑え込んだ・打ち破ったことを報じる記事は、実質的にはもう一方のクラブが
// 主役であり、「◯◯のエース」として名前が出てくるクラブは対戦相手としての
// 言及に過ぎない。「◯◯戦」と同様、この形の言及しかないクラブは主役として
// ヒットさせない。LINEUP_CONTAINMENT_VERBS的な抑制系動詞をそのまま流用
// しないのは、「浦和のエース〇〇が活躍」のように、自クラブのエースが好調な
// ポジティブな記事まで誤って除外してしまうリスクがあるため。ここでは
// 「相手がエースを攻略・打ち破った」という向きが一意に定まる動詞だけを使う。
const ACE_CONTAINMENT_MARKER = "エース";
const ACE_CONTAINMENT_VERBS = ["攻略", "打ち崩", "封じ", "抑え込"];
const ACE_CONTAINMENT_WINDOW = 20;

function isAceContainmentMention(scanText, idx, kwLength) {
  const afterText = scanText.slice(idx + kwLength);
  if (!afterText.startsWith(ACE_CONTAINMENT_MARKER)) return false;
  const window = afterText.slice(0, ACE_CONTAINMENT_MARKER.length + ACE_CONTAINMENT_WINDOW);
  return ACE_CONTAINMENT_VERBS.some((verb) => window.includes(verb));
}

// 「◇J1第20節 浦和―柏（2026年7月17日、埼玉）」のように、試合概要をまとめた
// 括弧書き(冒頭付近に付くことが多い)の末尾に会場名が来る定型がある。
// メディアによって括弧内の構成要素(日付だけ/リーグ名・対戦カード・節・
// 日付の組み合わせ等)が異なるため、「YYYY年M月D日」という特定の日付書式
// だけを手がかりにすると別テンプレートを取りこぼす(姉妹サイトCuration NPBの
// 運用で、開催地に過ぎない地名がクラブ名として誤ヒットする事例が複数の
// 異なる括弧書式で確認されている)。そこで「直近の開き括弧から現在位置までの
// 間に閉じ括弧を挟んでいない(=今、括弧の中にいる)」かつ「そのクラブ名の
// 直後が閉じ括弧」という位置関係に加え、括弧内に「節」「◯日」「◯年」の
// ような試合概要特有の日付・節表現が含まれる場合だけ、開催地表記とみなして
// 除外する。この最後の条件により、単に「選手名（クラブ名）」のような
// 無関係な注釈形式まで巻き込まないようにしている。
const VENUE_PAREN_CONTEXT_RE = /(第\d{1,2}節|\d{1,2}日|\d{4}年)/;

function isVenueParenMention(scanText, idx, kwLength) {
  const afterText = scanText.slice(idx + kwLength);
  if (!(afterText.startsWith("）") || afterText.startsWith(")"))) return false;

  const beforeText = scanText.slice(0, idx);
  const lastOpen = Math.max(beforeText.lastIndexOf("（"), beforeText.lastIndexOf("("));
  const lastClose = Math.max(beforeText.lastIndexOf("）"), beforeText.lastIndexOf(")"));
  if (lastOpen === -1 || lastOpen <= lastClose) return false;

  const parenContent = beforeText.slice(lastOpen);
  return VENUE_PAREN_CONTEXT_RE.test(parenContent);
}

function isMatchupCardMention(scanText, idx, kwLength) {
  for (const sep of MATCHUP_SEPARATORS) {
    const beforeSepStart = idx - sep.length;
    if (beforeSepStart >= 0 && scanText.slice(beforeSepStart, idx) === sep) {
      const beforeText = scanText.slice(0, beforeSepStart);
      if (ALL_TEAM_KEYWORDS.some((kw) => beforeText.endsWith(kw))) return true;
    }

    const afterSepStart = idx + kwLength;
    if (scanText.slice(afterSepStart, afterSepStart + sep.length) === sep) {
      const afterText = scanText.slice(afterSepStart + sep.length);
      if (ALL_TEAM_KEYWORDS.some((kw) => afterText.startsWith(kw))) return true;
    }
  }

  // 得点入りの対戦カード表記(例:「浦和3―1柏」「浦和 3-1 柏」)
  const afterText = scanText.slice(idx + kwLength);
  const scoreAfter = afterText.match(SCORE_GAP_AFTER_RE);
  if (scoreAfter && ALL_TEAM_KEYWORDS.some((kw) => afterText.slice(scoreAfter[0].length).startsWith(kw))) {
    return true;
  }

  const beforeText = scanText.slice(0, idx);
  const scoreBefore = beforeText.match(SCORE_GAP_BEFORE_RE);
  if (scoreBefore && ALL_TEAM_KEYWORDS.some((kw) => beforeText.slice(0, beforeText.length - scoreBefore[0].length).endsWith(kw))) {
    return true;
  }

  return false;
}

/**
 * キーワード群それぞれについて、テキスト中の「主役としての言及」の位置を返す。
 * 除外する言及が3種類ある。
 *  1.「◯◯戦」「◯◯との試合/カード/対戦」(=◯◯を相手にした試合、という意味の
 *    言い回し)としてしか出てこないキーワードは、記事の主役ではなく対戦相手を
 *    指しているとみなす。
 *  2.「浦和―柏」のような対戦カード表記としてしか出てこないキーワードも、
 *    1と同様に対戦相手(または単なる本拠地表記)としての言及とみなす
 *    (isMatchupCardMention参照)。
 *  3. excludeSpansの範囲内に入っている言及(例:「東京ヴェルディ」という
 *    長い一致の内部にたまたま含まれる短い一致)は、実体としては1つの言及を
 *    重複カウントしているだけなので除外する。
 * それ以外の言及が一つでもあれば、その最初の位置を返す。
 */
// 「【浦和戦みどころ】初戦スタメンは…」のように、見出し先頭の【】直後が
// 「◯◯戦」で始まる場合の「戦」は、対戦相手としての言及ではなく「そのクラブの
// 試合」を指す定型のコラム見出しフォーマット。通常の「◯◯戦」(文中で対戦相手を
// 指す言い回し)とは区別する必要があるため、直前の文字が見出し先頭の
// 角括弧の開始(【または[)である場合だけ例外的に主役側とみなす。
function isColumnTitleTeamMention(scanText, idx) {
  return idx > 0 && (scanText[idx - 1] === "【" || scanText[idx - 1] === "[");
}

// 「◯◯戦」だけでなく、「柏第7節」(=柏との今シーズン7回目の対戦、という
// 意味の定型表現)のように、クラブ名と「戦」の間に節数を表す数字が挟まる
// ことがある。「浦和との試合（埼玉スタジアム）に2－1で勝利」のように、
// 「◯◯戦」ではなく「◯◯との試合/カード/対戦」という言い回しで対戦相手を
// 指すこともあるため、あわせて対戦相手表現として扱う。
const OPPONENT_SUFFIX_RE = /^((第\d{1,2}節)?戦|との(試合|カード|対戦))/;

function findSubjectIndex(scanText, keywords, excludeSpans = []) {
  let subjectIndex = -1;
  for (const kw of keywords) {
    let searchFrom = 0;
    while (searchFrom <= scanText.length) {
      const idx = scanText.indexOf(kw, searchFrom);
      if (idx === -1) break;
      searchFrom = idx + kw.length;

      const withinExcluded = excludeSpans.some(([start, end]) => idx >= start && idx < end);
      if (withinExcluded) continue;

      const isOpponentMention =
        OPPONENT_SUFFIX_RE.test(scanText.slice(idx + kw.length)) &&
        !isColumnTitleTeamMention(scanText, idx);
      const isMatchupMention = isMatchupCardMention(scanText, idx, kw.length);
      const isAceMention = isAceContainmentMention(scanText, idx, kw.length);
      const isVenueMention = isVenueParenMention(scanText, idx, kw.length);
      if (
        !isOpponentMention &&
        !isMatchupMention &&
        !isAceMention &&
        !isVenueMention &&
        (subjectIndex === -1 || idx < subjectIndex)
      ) {
        subjectIndex = idx;
      }
    }
  }
  return subjectIndex;
}

// 「東京都出身」「東京都内」のように、「東京都」(Tokyo都)という非常に
// 頻出する語の中に、京都サンガのshortKeyword「京都」が偶然の部分文字列と
// して埋め込まれてしまう(「東京都」＝東+京都)。実データで「総勢1915人の
// J選手…出身地で多いのは？1位は東京都が継続」という全クラブ横断の記事が、
// 「東京都」という言及だけで京都サンガのタグとして誤ヒットする事例を確認
// した。「東京都」というテキストが出現した場合、その中の「京都」部分
// (東の次の2文字)を除外スパンとして扱う。
const TOKYO_TO_RE = /東京都/g;

function findFalseSubstringSpans(scanText) {
  const spans = [];
  let m;
  while ((m = TOKYO_TO_RE.exec(scanText))) {
    spans.push([m.index + 1, m.index + 3]);
  }
  return spans;
}

/**
 * 指定したテキストの中から該当するクラブを、文中での出現位置が早い順に返す。
 * strongKeywords（正式名称・愛称。他分野と混同しにくい）は単独でヒット扱い。
 * shortKeywords（「浦和」「柏」「広島」など、地名・一般名詞としても使われる
 * 曖昧な略称）は、bracketHit（見出し冒頭の【○○】表記）かサッカー文脈の
 * 裏付けがある場合のみヒット扱いにする。
 * どちらのキーワード種別でも、「◯◯戦」形の対戦相手としての言及しかない
 * 場合はヒットさせない(findSubjectIndex参照)。また、shortKeywordsの一致が
 * strongKeywordsの一致の内部に埋もれている場合も、二重カウントを避けるため
 * 除外する。
 */
function collectTeamHits(scanText, bracketText, hasSoccerContext) {
  const hits = [];

  for (const team of TEAMS) {
    const strongSpans = findAllSpans(scanText, team.strongKeywords);
    const strongIndex = findSubjectIndex(scanText, team.strongKeywords);
    if (strongIndex !== -1) {
      hits.push({ id: team.id, index: strongIndex });
      continue;
    }

    const shortKw = team.shortKeywords.find((kw) => scanText.includes(kw));
    if (!shortKw) continue;

    const bracketHit = team.shortKeywords.some((kw) => bracketText.includes(kw));
    if (bracketHit || hasSoccerContext) {
      const excludeSpans = [...strongSpans, ...findFalseSubstringSpans(scanText)];
      const shortIndex = findSubjectIndex(scanText, team.shortKeywords, excludeSpans);
      if (shortIndex !== -1) {
        hits.push({ id: team.id, index: shortIndex });
      }
    }
  }

  hits.sort((a, b) => a.index - b.index);
  return hits.map((h) => h.id);
}

// 特定の定型フォーマット(見出しの言い回し)に依存しないタイプの複数クラブ
// 横断記事(例:「J1全20クラブの夏の補強を総まとめ」のような特集)が存在する。
// 姉妹サイトCuration NPBでは個別の言い回しごとに専用の定型検出ロジックを
// 積み上げたが、Jリーグの実データではまだそうした定型パターンが確認できて
// いないため、v1では「実際に有効ヒットしたクラブ数が一定以上(=特定の1〜2
// クラブの話題ではなく、リーグ横断の話題)であれば一律で総合タグ扱いにする」
// という汎用的な安全網だけを設けている。移籍等の複数クラブが絡む記事は
// 現実的には最大でも3クラブ程度(2クラブ間の移籍＋関連クラブへの言及等)
// なので、しきい値は明確にそれを超える4クラブ以上に設定している。
// 実データで具体的な定型パターン(例:「◯節結果まとめ」のような記事)による
// 誤爆が見つかり次第、Curation NPBのisDailyResultsRoundup等と同じ要領で
// 個別の検出ロジックを追加していく。
const ROUNDUP_TEAM_COUNT_THRESHOLD = 4;

function applyRoundupTeamCountGuard(teamIds) {
  if (teamIds.length >= ROUNDUP_TEAM_COUNT_THRESHOLD) return [];
  return teamIds;
}

/**
 * クラブ判定のメイン処理。3段階のフォールバックで判定する。
 *
 * 試合結果系の記事は、本文(summary)側に必ず対戦相手のクラブ名が出てくる
 * (例:「浦和レッズ戦に先発出場」)。タイトル+本文をまとめて1つのテキスト
 * として判定すると、記事の主役ではない「対戦相手」まで一緒にクラブタグ
 * として付いてしまい、そのクラブのページに無関係な記事が紛れ込む原因に
 * なる。
 *
 * 1. タイトルだけで判定(通常ルール: 曖昧な略称はサッカー文脈が必要)
 * 2. 1で何もヒットしない場合、タイトルだけで再判定(略称のサッカー文脈
 *    チェックを「Jリーグ等の一般キーワード」から「ゴール・移籍・退場等の
 *    実際の試合展開/選手動向を示す語彙」に緩める)。タイトルは本文と違って
 *    簡潔なので、多少緩めても「浦和のFW…今季5点目」のような自然な見出しを
 *    拾える一方、「柏市でイベント開催」のような地名としての言及までは
 *    拾わない
 * 3. 2でもヒットしない場合(見出しにクラブ名が一切ない)だけ、本文も含めて
 *    通常ルールで判定する
 */
function matchTeamsForItem(title, summary, feedScoped) {
  const bracketMatch = title.match(/^[【\[]([^】\]]+)[】\]]/);
  const bracketText = bracketMatch ? bracketMatch[1] : "";

  const titleHits = collectTeamHits(title, bracketText, feedScoped || matchesGeneralJleague(title));
  if (titleHits.length > 0) return applyRoundupTeamCountGuard(titleHits);

  const titleHitsRelaxed = collectTeamHits(title, bracketText, matchesSoccerAction(title));
  if (titleHitsRelaxed.length > 0) return applyRoundupTeamCountGuard(titleHitsRelaxed);

  const combined = `${title} ${summary}`;
  const hasSoccerContext = feedScoped || matchesGeneralJleague(combined);
  return applyRoundupTeamCountGuard(collectTeamHits(combined, bracketText, hasSoccerContext));
}

function matchesGeneralJleague(text) {
  return GENERAL_JLEAGUE_KEYWORDS.some((kw) => text.includes(kw));
}

/**
 * 記事のタイトル+要約から、話題タグ(移籍・負傷・契約更改など)を判定する。
 * クラブ判定のような「主役/対戦相手」の区別は不要な単純なキーワード一致で良い
 * (話題の判定に「対戦相手」という概念がないため)。1記事に複数の話題タグが
 * つくこともある(例:「負傷離脱していた選手が新加入発表」)。
 */
function classifyTopics(haystack) {
  const hits = [];
  for (const topic of TOPICS) {
    if (topic.keywords.some((kw) => haystack.includes(kw))) {
      hits.push(topic.id);
    }
  }
  return hits;
}

function stripHtml(input) {
  if (!input) return "";
  return input
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#8211;/g, "–")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(text, max = 120) {
  if (text.length <= max) return text;
  return text.slice(0, max).trim() + "…";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// parser.parseURL単体を切り出し、タイムアウト等の一時的な失敗時に
// FEED_RETRY_COUNT回まで再試行する。「タイムアウト」は接続自体は
// できているが応答が遅いだけのケースが多く、1回の再試行で拾えることが
// 多いため(サイト側が明確にブロックしている場合は再試行しても無駄だが、
// 再試行のコスト自体は小さいので、区別せず一律で試みる)。
async function parseWithRetry(feed) {
  let lastErr;
  for (let attempt = 0; attempt <= FEED_RETRY_COUNT; attempt++) {
    try {
      return await parser.parseURL(feed.url);
    } catch (err) {
      lastErr = err;
      if (attempt < FEED_RETRY_COUNT) {
        console.warn(`  取得リトライ: ${feed.name} — ${err.message}`);
        await sleep(FEED_RETRY_DELAY_MS);
      }
    }
  }
  throw lastErr;
}

async function fetchFeed(feed) {
  try {
    const parsed = await parseWithRetry(feed);
    const items = (parsed.items ?? []).slice(0, MAX_PER_FEED);
    const results = [];

    for (const item of items) {
      const title = stripHtml(item.title ?? "");
      const summary = truncate(
        stripHtml(item.contentSnippet ?? item.content ?? item.summary ?? ""),
      );
      const link = item.link ?? "";
      if (!title || !link) continue;

      // 分類・除外判定は「(◯◯スポーツ)」等の出典表記を取り除いたテキストで
      // 行う(表示用のtitle自体はそのまま保持する)。理由はstripTrailingSourceSuffix
      // のコメント参照。
      const titleForMatching = normalizeWidthForMatching(stripTrailingSourceSuffix(title));
      const summaryForMatching = normalizeWidthForMatching(summary);
      const haystack = `${titleForMatching} ${summaryForMatching}`;

      // 対象外カテゴリ・他競技等のカテゴリ除外判定だけは、出典表記を取り除く
      // 前の生タイトルで行う(出典表記も含める)。stripTrailingSourceSuffix
      // が懸念するのはクラブの曖昧な略称と出典名との偶然の一致だが、
      // 「高校サッカー」「プロ野球」のようなカテゴリキーワードが出典名に
      // 含まれる場合はその出典が実際にそのジャンルの専門メディアである
      // ことを示す強いシグナルであり、除外判定にはむしろ積極的に使いたい。
      const exclusionHaystack = `${normalizeWidthForMatching(title)} ${summaryForMatching}`;

      // 高校サッカー・なでしこリーグ等対象外カテゴリの記事は、クラブ名を
      // 含んでいても除外する
      if (OUT_OF_SCOPE_KEYWORDS.some((kw) => exclusionHaystack.includes(kw))) continue;

      // 野球・ゴルフ等、サッカーではない他競技の記事は除外する
      if (isOtherSportsContent(exclusionHaystack)) continue;

      // マスコット来場のアイドル来場・ファンミーティング等、クラブ名に
      // ヒットしても実質的にはサッカーと無関係な芸能・エンタメ記事は除外する
      if (isEntertainmentNoise(exclusionHaystack)) continue;

      // 「広告ゼロ」が差別化点なので、PR・タイアップ記事は取得元フィードに
      // 含まれていても掲載しない
      if (isAdContent(title)) continue;

      // 元選手の実業家転身インタビュー等、試合・クラブの動向とは無関係な
      // 経歴紹介記事は除外する(isRetiredPlayerBusinessProfile参照)
      if (isRetiredPlayerBusinessProfile(haystack)) continue;

      const teamHits = matchTeamsForItem(titleForMatching, summaryForMatching, feed.scoped);
      const generalHit = matchesGeneralJleague(haystack);
      const topicHits = classifyTopics(haystack);

      // scoped=true のフィード(専門メディアの国内サッカーカテゴリ)は
      // 無条件で採用。scoped=false (総合スポーツフィード)は「クラブヒット
      // あり」「一般Jリーグキーワードあり」のいずれかがある記事だけを採用し、
      // 他競技・他分野の記事(例:「柏」→地名の一般ニュース 等)を除外する。
      if (!feed.scoped) {
        const isRelevant = teamHits.length > 0 || generalHit;
        if (!isRelevant) continue;
      }

      const pubDate = item.isoDate ?? item.pubDate ?? null;

      results.push({
        title,
        summary,
        link,
        pubDate,
        source: feed.name,
        sourceId: feed.id,
        teams: teamHits,
        topics: topicHits,
        sources: [{ name: feed.name, sourceId: feed.id, link }],
      });
    }

    console.log(`  取得成功: ${feed.name} (${results.length}件)`);
    return results;
  } catch (err) {
    console.warn(`  取得失敗: ${feed.name} — ${err.message}`);
    return [];
  }
}

/** 既存の src/data/news.json を読み込む。無い/壊れている場合は空配列扱い */
async function loadExistingItems() {
  try {
    const raw = await readFile(OUTPUT_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.items) ? parsed.items : [];
  } catch {
    return [];
  }
}

function linkKey(link) {
  return link.split("?")[0];
}

// ---- 同一ニュースの重複統合(マルチソース化) ----------------------------
//
// 複数のサッカー専門メディアが同じ出来事(移籍発表・負傷離脱など)を報じた
// 場合、タイトルはメディアごとに言い回しが異なるためlinkKeyでは重複と
// 判定できない。ここでは「タイトルの2文字(バイグラム)Jaccard類似度」
// 「公開時刻の近さ」「クラブタグの重なり」の3条件がすべて揃った記事だけを
// 同一ニュースとみなし、1件にまとめて複数の出典リンク(sources)を持たせる。
// 条件を厳しめにしているのは、無関係な2つのニュースを誤って1件に統合して
// しまう方が、統合し損ねるより悪いため(見せかけの1件に情報が隠れてしまう)。

function normalizeTitleForCompare(title) {
  return title
    // 見出し冒頭の【浦和】のようなクラブプレフィックスは類似度判定のノイズになるため除去
    .replace(/^[【\[][^】\]]*[】\]]/, "")
    // 全角英数記号を半角へ寄せる
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[\s　]/g, "")
    .toLowerCase();
}

function titleBigrams(text) {
  const set = new Set();
  if (text.length < 2) {
    if (text.length === 1) set.add(text);
    return set;
  }
  for (let i = 0; i < text.length - 1; i++) {
    set.add(text.slice(i, i + 2));
  }
  return set;
}

function jaccardSimilarity(setA, setB) {
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const gram of setA) {
    if (setB.has(gram)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function itemSources(item) {
  if (Array.isArray(item.sources) && item.sources.length > 0) return item.sources;
  return [{ name: item.source, sourceId: item.sourceId, link: item.link }];
}

/** Union-Find(素集合データ構造)。同一ニュース判定されたインデックス同士を連結する */
function createUnionFind(size) {
  const parent = Array.from({ length: size }, (_, i) => i);
  function find(x) {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  }
  function union(a, b) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }
  return { find, union };
}

function mergeDuplicateGroup(groupItems) {
  if (groupItems.length === 1) {
    const only = groupItems[0];
    return { ...only, sources: itemSources(only) };
  }

  // 一番要約が長い(=情報量が多い)記事を代表記事として採用する
  const primary = groupItems.reduce((best, current) =>
    (current.summary?.length ?? 0) > (best.summary?.length ?? 0) ? current : best,
  );

  // 表示用の公開時刻は「一番早く報じられた時刻」を採用する
  const dated = groupItems.filter(
    (it) => it.pubDate && !Number.isNaN(new Date(it.pubDate).getTime()),
  );
  const earliestPubDate =
    dated.length > 0
      ? dated.reduce((a, b) => (new Date(a.pubDate) < new Date(b.pubDate) ? a : b)).pubDate
      : (groupItems[0].pubDate ?? null);

  const seenSourceKey = new Set();
  const mergedSources = [];
  for (const it of groupItems) {
    for (const src of itemSources(it)) {
      const key = `${src.sourceId}|${src.link}`;
      if (seenSourceKey.has(key)) continue;
      seenSourceKey.add(key);
      mergedSources.push(src);
    }
  }
  // 代表記事の出典を先頭に並べ替える
  mergedSources.sort((a, b) => {
    const aIsPrimary = a.sourceId === primary.sourceId && a.link === primary.link;
    const bIsPrimary = b.sourceId === primary.sourceId && b.link === primary.link;
    return aIsPrimary === bIsPrimary ? 0 : aIsPrimary ? -1 : 1;
  });

  const primaryTeams = primary.teams ?? [];
  const otherTeams = groupItems.flatMap((it) => it.teams ?? []).filter((t) => !primaryTeams.includes(t));
  const teams = [...primaryTeams, ...new Set(otherTeams)];
  const topics = [...new Set(groupItems.flatMap((it) => it.topics ?? []))];

  return {
    title: primary.title,
    summary: primary.summary,
    link: primary.link,
    pubDate: earliestPubDate,
    source: primary.source,
    sourceId: primary.sourceId,
    teams,
    topics,
    sources: mergedSources,
  };
}

function dedupeSameEventItems(items) {
  // 日付不明の記事は判定材料が不足するため統合対象から外す(そのまま残す)
  const comparable = [];
  const untouched = [];
  items.forEach((item, i) => {
    if (item.pubDate && !Number.isNaN(new Date(item.pubDate).getTime()) && (item.teams?.length ?? 0) > 0) {
      comparable.push(i);
    } else {
      untouched.push(item);
    }
  });

  const uf = createUnionFind(items.length);
  const normalized = items.map((it) => normalizeTitleForCompare(it.title));
  const bigramCache = normalized.map((t) => titleBigrams(t));

  // 同じ日(JST)ごとにバケット化して比較回数を抑える
  const dayBuckets = new Map();
  for (const i of comparable) {
    const dayKey = new Date(items[i].pubDate).toISOString().slice(0, 10);
    if (!dayBuckets.has(dayKey)) dayBuckets.set(dayKey, []);
    dayBuckets.get(dayKey).push(i);
  }

  for (const bucket of dayBuckets.values()) {
    for (let a = 0; a < bucket.length; a++) {
      for (let b = a + 1; b < bucket.length; b++) {
        const i = bucket[a];
        const j = bucket[b];
        const timeDiff = Math.abs(
          new Date(items[i].pubDate).getTime() - new Date(items[j].pubDate).getTime(),
        );
        if (timeDiff > DEDUPE_WINDOW_MS) continue;

        const teamsOverlap = items[i].teams.some((t) => items[j].teams.includes(t));
        if (!teamsOverlap) continue;

        const similarity = jaccardSimilarity(bigramCache[i], bigramCache[j]);
        if (similarity >= DEDUPE_TITLE_SIMILARITY) {
          uf.union(i, j);
        }
      }
    }
  }

  const groups = new Map();
  for (const i of comparable) {
    const root = uf.find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(items[i]);
  }

  const mergedResults = [...groups.values()].map(mergeDuplicateGroup);
  return [...mergedResults, ...untouched];
}

async function main() {
  console.log(`Jリーグニュース収集を開始します (${FEEDS.length}フィード)`);

  const allResults = (
    await Promise.all(FEEDS.map((feed) => fetchFeed(feed)))
  ).flat();

  const existingItemsRaw = await loadExistingItems();

  // 除外ルール(AD_MARKERS・OUT_OF_SCOPE_KEYWORDS・ENTERTAINMENT_NOISE_KEYWORDS・
  // OTHER_SPORTS_KEYWORDS)は運用中に追加・調整されることがある。ルール変更後も
  // RSSの取得範囲から外れてしまった古い記事は再取得されず、最大30日間
  // アーカイブに残り続けてしまうため、既存アーカイブに対しても同じ除外
  // ルールを毎回かけ直し、該当する記事はその場で取り除く。
  //
  // また、クラブ分類ロジック(matchTeamsForItem)自体が改善された場合も、
  // 既存アーカイブの記事を毎回再分類することで、過去に誤って対戦相手の
  // クラブタグが付いた記事を遡って修正できるようにしている。
  const existingItems = existingItemsRaw
    .filter((item) => {
      const summaryForMatching = normalizeWidthForMatching(item.summary ?? "");
      // カテゴリ除外判定は出典表記を残した生タイトルで行う(fetchFeed内の
      // 同種の判定と同じ理由。exclusionHaystackのコメント参照)
      const exclusionHaystack = `${normalizeWidthForMatching(item.title)} ${summaryForMatching}`;
      const titleForMatching = normalizeWidthForMatching(stripTrailingSourceSuffix(item.title));
      const haystack = `${titleForMatching} ${summaryForMatching}`;
      if (OUT_OF_SCOPE_KEYWORDS.some((kw) => exclusionHaystack.includes(kw))) return false;
      if (isOtherSportsContent(exclusionHaystack)) return false;
      if (isEntertainmentNoise(exclusionHaystack)) return false;
      if (isAdContent(item.title)) return false;
      if (isRetiredPlayerBusinessProfile(haystack)) return false;
      return true;
    })
    .map((item) => {
      const feedScoped = FEEDS.find((f) => f.id === item.sourceId)?.scoped ?? false;
      const titleForMatching = normalizeWidthForMatching(stripTrailingSourceSuffix(item.title));
      const summaryForMatching = normalizeWidthForMatching(item.summary ?? "");
      const teams = matchTeamsForItem(titleForMatching, summaryForMatching, feedScoped);
      return { ...item, teams };
    });
  const removedByRuleUpdate = existingItemsRaw.length - existingItems.length;
  console.log(
    `  既存アーカイブ: ${existingItemsRaw.length}件` +
      (removedByRuleUpdate > 0 ? ` (除外ルール更新により${removedByRuleUpdate}件を除去)` : ""),
  );

  // 新規取得分を優先しつつ、既存アーカイブとリンクで重複排除してマージする。
  // (同じ記事を新しい取得結果で上書きすることで、分類ロジック改善時に
  //  まだRSSの取得範囲内にある記事は再分類の恩恵を受けられる)
  const merged = new Map();
  for (const item of existingItems) {
    merged.set(linkKey(item.link), item);
  }
  for (const item of allResults) {
    merged.set(linkKey(item.link), item);
  }

  // 直近RETENTION_DAYS日分だけを残すローリングウィンドウ。日付不明の記事は
  // (稀なケースなので)念のため残しておき、MAX_ITEMSの上限で吸収する。
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const withinRetention = [...merged.values()].filter((item) => {
    if (!item.pubDate) return true;
    const t = new Date(item.pubDate).getTime();
    return Number.isNaN(t) || t >= cutoff;
  });

  // 複数メディアが同じ出来事を報じている記事を1件に統合する(マルチソース化)
  const deduped = dedupeSameEventItems(withinRetention);
  const mergedAwayCount = withinRetention.length - deduped.length;

  // 日付降順ソート（日付不明は末尾へ）
  deduped.sort((a, b) => {
    const da = a.pubDate ? new Date(a.pubDate).getTime() : 0;
    const db = b.pubDate ? new Date(b.pubDate).getTime() : 0;
    return db - da;
  });

  const trimmed = deduped.slice(0, MAX_ITEMS);
  const prunedByAge = merged.size - withinRetention.length;
  const prunedByCap = deduped.length - trimmed.length;

  const output = {
    generatedAt: new Date().toISOString(),
    count: trimmed.length,
    items: trimmed,
  };

  await writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2) + "\n", "utf-8");
  console.log(
    `完了: ${trimmed.length}件を src/data/news.json に書き出しました` +
      `(今回の新規取得 ${allResults.length}件 / ${RETENTION_DAYS}日超で除外 ${prunedByAge}件` +
      `${mergedAwayCount > 0 ? ` / 同一ニュース統合で ${mergedAwayCount}件を集約` : ""}` +
      `${prunedByCap > 0 ? ` / 上限超過で除外 ${prunedByCap}件` : ""})`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
