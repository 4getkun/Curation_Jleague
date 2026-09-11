// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

// 公開URL: https://fourgetkun.com/jleague-news/ (fourgetkun-hub 配下)
// リポジトリ: https://github.com/4getkun/Curation_Jleague
//
// ビルド成果物の置き場は従来どおり GitHub Pages
// (https://4getkun.github.io/Curation_Jleague/) だが、ここはあくまで「配信元」。
// 利用者が見るのは fourgetkun.com/jleague-news/ で、fourgetkun-hub の Worker が
// /jleague-news/* へのリクエストを GitHub Pages から取ってきて返す(リバースプロキシ。
// fourgetkun-hub の src/pages-proxy/proxy.js)。そのため site/base は公開側の
// URL に合わせる。GitHub Pages の URL で直接開かれた場合は Base.astro の
// インラインスクリプトが fourgetkun.com 側へ転送する。
export default defineConfig({
  site: 'https://fourgetkun.com',
  base: '/jleague-news',
  trailingSlash: 'always',
  vite: {
    plugins: [tailwindcss()],
  },
});
