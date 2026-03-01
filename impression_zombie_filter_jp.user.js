// ==UserScript==
// @name         X インプレゾンビ 自動フィルター【日本語バズ特化版】
// @namespace    https://github.com/your-name/x-zombie-filter-jp
// @version      2.2.0
// @description  日本語バズツイートへのリプライ欄に紛れる「海外インプレゾンビ」「AI生成日本語ゾンビ」を自動検出・非表示にします
// @author       YourName
// @match        https://x.com/*
// @match        https://twitter.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // =============================================
  //  設定
  // =============================================
  const CONFIG = {
    // スコアがこの値以上でゾンビとみなす（2〜5で調整）
    threshold: GM_getValue('zombie_threshold', 3),
    debounceMs: 350,
    mode: GM_getValue('zombie_mode', 'collapse'),
    debug: GM_getValue('zombie_debug', false),
  };

  // =============================================
  //  スタイル注入
  // =============================================
  GM_addStyle(`
    /* 折りたたみ中のツイート本体：一行分の高さに固定 */
    .xzf-zombie-collapsed {
      position: relative !important;
      border: 1.5px solid #553e46 !important;
      border-radius: 8px !important;
      margin: 2px 0 !important;
      height: 36px !important;
      min-height: unset !important;
      max-height: 36px !important;
      overflow: hidden !important;
    }
    /* 中身を完全に不可視化 */
    .xzf-zombie-collapsed > * {
      visibility: hidden !important;
      pointer-events: none !important;
    }
    /* 展開済み：高さ制限を解除して中身を再表示 */
    .xzf-zombie-collapsed.xzf-expanded {
      height: auto !important;
      max-height: none !important;
      overflow: visible !important;
    }
    .xzf-zombie-collapsed.xzf-expanded > * {
      visibility: visible !important;
      pointer-events: auto !important;
    }
    /* 展開中はオーバーレイ非表示 */
    .xzf-zombie-collapsed.xzf-expanded .xzf-overlay { display: none !important; }

    /* オーバーレイ：常に最前面、ホバーに一切反応しない */
    .xzf-overlay {
      position: absolute !important;
      inset: 0 !important;
      z-index: 9999 !important;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      background: rgba(10,10,15,0.88) !important;
      border-radius: 13px !important;
      cursor: pointer !important;
      user-select: none !important;
      visibility: visible !important;
      pointer-events: auto !important;
    }
    .xzf-overlay span {
      font-size: 12px;
      font-family: 'Helvetica Neue', 'Hiragino Sans', sans-serif;
      color: #814250;
      letter-spacing: 0.3px;
      pointer-events: none;
    }
    .xzf-zombie-hidden { display: none !important; }

    /* ---- UI パネル ---- */
    #xzf-panel {
      position: fixed;
      bottom: 70px;
      right: 16px;
      z-index: 99999;
      background: rgba(13,17,23,0.92);
      border: 1px solid #5f424b;
      border-radius: 20px;
      padding: 8px 14px;
      font-family: 'Helvetica Neue', 'Hiragino Sans', sans-serif;
      color: #c9d1d9;
      box-shadow: 0 4px 16px rgba(0,0,0,0.5);
      display: flex;
      align-items: center;
      gap: 10px;
      user-select: none;
      cursor: default;
      white-space: nowrap;
    }
    #xzf-panel .xzf-icon { font-size: 15px; }
    #xzf-panel .xzf-stat {
      font-size: 11px;
      color: #8b949e;
      display: flex;
      align-items: center;
      gap: 4px;
    }
    #xzf-panel .xzf-stat .val {
      font-size: 13px;
      font-weight: 800;
      color: #fff;
    }
    #xzf-panel .xzf-stat.blocked .val { color: #e0245e; }
    #xzf-panel .xzf-divider {
      width: 1px; height: 16px;
      background: #30363d;
    }
  `);

  // =============================================
  //  ユーティリティ
  // =============================================
  const CJK_RE = /[\u3000-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/;
  const HIRAGANA_RE = /[\u3040-\u309F]/;
  const KATAKANA_RE = /[\u30A0-\u30FF]/;
  const KANJI_RE    = /[\u4E00-\u9FFF]/;
  const ARABIC_RE   = /[\u0600-\u06FF]/;
  const CYRILLIC_RE = /[\u0400-\u04FF]/;
  const THAI_RE     = /[\u0E00-\u0E7F]/;
  const DEVANAGARI_RE = /[\u0900-\u097F]/;

  function hasJapanese(t) {
    return HIRAGANA_RE.test(t) || KATAKANA_RE.test(t) || KANJI_RE.test(t);
  }
  function hasCJK(t) { return CJK_RE.test(t); }

  // 文字列中の各スクリプトの割合を返す
  function scriptRatios(t) {
    const clean = t.replace(/\s/g, '');
    if (!clean.length) return {};
    let jp = 0, latin = 0, arabic = 0, cyrillic = 0, thai = 0, deva = 0;
    for (const c of clean) {
      const cp = c.codePointAt(0);
      if ((cp >= 0x3040 && cp <= 0x30FF) || (cp >= 0x4E00 && cp <= 0x9FFF)) jp++;
      else if ((cp >= 0x41 && cp <= 0x7A) || (cp >= 0xC0 && cp <= 0x024F)) latin++;
      else if (cp >= 0x0600 && cp <= 0x06FF) arabic++;
      else if (cp >= 0x0400 && cp <= 0x04FF) cyrillic++;
      else if (cp >= 0x0E00 && cp <= 0x0E7F) thai++;
      else if (cp >= 0x0900 && cp <= 0x097F) deva++;
    }
    const total = clean.length;
    return { jp: jp/total, latin: latin/total, arabic: arabic/total,
             cyrillic: cyrillic/total, thai: thai/total, deva: deva/total };
  }

  // =============================================
  //  AI 生成日本語パターン集
  //  （ChatGPT / DeepSeek / Gemini 等が吐きがちな定型文）
  // =============================================
  const AI_JP_PATTERNS = [
    // ── 感嘆・称賛系（最頻出）──
    /^(本当に|まさに|とても|非常に|実に|素直に)?(素晴らし[いく]|すばらし[いく]|感動(的)?|素敵|すてき|最高)(です|ですね|！|!|ね[！!]?|…)*$/,
    /^(この|その)?(投稿|ツイート|内容|情報|記事|シェア)(は|が)?(とても|非常に|本当に)?(参考|勉強|興味深)[にになり]+(なりました|なります|ます)[！!。]?$/,
    /^(シェアして|共有して)?(いただき)?ありがとう(ございます|ございました)[！!。]?$/,
    /^(とても|非常に|大変)?(参考になりました|勉強になりました|ためになりました)[！!。]?$/,
    /^(本当に|まさに)?(その通り|おっしゃる通り|同感です|同意します)[！!。]?$/,
    /^(これは|この(情報|投稿|ツイート)は)?(必見|必読|必要|重要|大切)(です|ですね|だと思います)[！!。]?$/,
    /^(貴重な|重要な|有益な)(情報|知識|内容)(を)?(ありがとう|共有|シェア)(ございます)?[！!。]?$/,
    /^(こんな(素晴らしい|良い|興味深い))?(情報|投稿|ツイート)(が)?(あったとは|があるとは)(知りませんでした|思いませんでした)[！!。]?$/,
    // ── 応援・励まし系 ──
    /^(頑張って|がんばって)[くださいね！!。]?$/,
    /^(引き続き)?(よろしく|応援しています)[！!。]?$/,
    /^(これからも)?(素晴らしい|良い)(活動|投稿|発信)(を)?(期待しています|楽しみにしています)[！!。]?$/,
    // ── 無内容な相槌 ──
    /^(なるほど[！!。]?){1,3}$/,
    /^(そうですね[！!。]?){1,3}$/,
    /^(確かに[！!。]?){1,3}$/,
    /^(了解(しました)?[！!。]?){1,2}$/,
    /^(素晴らしい[！!。]?){1,3}$/,
    /^(ありがとうございます[！!。]?){1,2}$/,
    // ── フォロー誘導・宣伝系 ──
    /フォロー(して|お願い|よろしく)/,
    /相互フォロー/,
    /フォロバ/,
    /フォローしてくれたら/,
    /(私の|僕の|弊社の)(アカウント|プロフィール|ページ)(も|を)(ぜひ|よろしく)/,
    // ── AIらしい冗長な結び ──
    /この(情報|知識|内容)が(お役に立てれば|皆さんのお役に立てれば)(幸いです|と思います)/,
    /皆さんも(ぜひ|是非)(参考に|試して|チェックして)みてください/,
    /今後も(このような|こんな)(有益な|素晴らしい)(情報|投稿)(を)?(よろしく|期待しています)/,
    /一緒に(頑張り|成長し)(ましょう|ましょうね)[！!。]?/,
  ];

  // AI生成っぽい「過剰に丁寧な日本語」の語彙チェック
  const AI_JP_VOCAB = [
    '貴重な情報', '有益な情報', '素晴らしい投稿', '参考になりました',
    '勉強になりました', 'シェアありがとう', '共有ありがとう',
    'おっしゃる通り', '非常に興味深い', '大変参考', '是非参考に',
    'お役に立てれば幸い', '皆さんのお役に', '引き続きよろしく',
    'これからも応援', '素晴らしい活動', '有意義な', '充実した内容',
    '深い洞察', '鋭い指摘', '的確な分析',
  ];

  // =============================================
  //  スコアリング本体
  // =============================================
  const reasonCounter = {}; // 統計用
  const handleReplyCount = {}; // ハンドルごとのリプライ数を追跡

  function calcZombieScore(article) {
    let score = 0;
    const reasons = [];
    const add = (s, r) => { score += s; reasons.push(r); reasonCounter[r] = (reasonCounter[r]||0)+1; };

    const getText = (sel) => article.querySelector(sel)?.textContent?.trim() ?? '';

    const tweetText   = getText('[data-testid="tweetText"]');
    const displayName = getText('[data-testid="User-Name"]');
    const handle      = article.querySelector('[data-testid="User-Name"] a[href^="/"]')
                          ?.getAttribute('href')?.replace('/', '') ?? '';

    // プロフィールbio：リプライ一覧では article 内の複数セレクタを試みる
    // （ホバーカード表示時 / インライン表示時 どちらにも対応）
    const bioText = (
      article.querySelector('[data-testid="UserDescription"]')?.textContent?.trim()
      ?? article.querySelector('[data-testid="HoverCard"] [data-testid="UserDescription"]')?.textContent?.trim()
      ?? article.closest('[data-testid="HoverCard"]')?.querySelector('[data-testid="UserDescription"]')?.textContent?.trim()
      // ユーザーセル（フォロワー一覧等）でのbio
      ?? article.querySelector('[data-testid="userCell"] [dir]')?.textContent?.trim()
      ?? ''
    );

    const ratios    = scriptRatios(tweetText);
    const bioRatios = scriptRatios(bioText);
    const jpThread  = isJapaneseThread();

    // ------------------------------------------------------------------
    // A. 【海外アカウント判定】
    //    ツイート本文 / プロフィールbio それぞれ独立して +3 を加算
    //    → 両方引っかかれば +6 で確実に消える
    // ------------------------------------------------------------------

    if (jpThread) {

      // ── A-1. ツイート本文が外国語 → +3 ──
      const isForeignTweet = (() => {
        const bodyIsNonJP = tweetText.length > 3 && !hasJapanese(tweetText);
        const hasForeignScript = ratios.arabic  > 0.2 || ratios.cyrillic > 0.2
                               || ratios.thai   > 0.2 || ratios.deva     > 0.2;
        const nameIsNonJP = !hasJapanese(displayName) && /^[a-zA-Z0-9_]+$/.test(handle);
        const isBotHandle = /^[a-zA-Z]{2,8}\d{4,}$/.test(handle);
        return bodyIsNonJP || hasForeignScript || isBotHandle || (nameIsNonJP && bodyIsNonJP);
      })();

      if (isForeignTweet) {
        let langLabel = '🌐 海外アカウント（本文）';
        if      (ratios.arabic   > 0.2) langLabel = '🇸🇦 アラビア語ツイート';
        else if (ratios.cyrillic > 0.2) langLabel = '🇷🇺 キリル文字ツイート';
        else if (ratios.thai     > 0.2) langLabel = '🇹🇭 タイ語ツイート';
        else if (ratios.deva     > 0.2) langLabel = '🇮🇳 デヴァナーガリーツイート';
        else if (!hasJapanese(tweetText) && ratios.latin > 0.5) langLabel = '🇺🇸 英語のみツイート';
        add(3, langLabel);
      }

      // ── A-2. プロフィールbioが外国語 → +3（独立加算）──
      if (bioText.length > 3) {
        const bioIsNonJP     = !hasJapanese(bioText);
        const bioHasForeign  = bioRatios.arabic   > 0.2 || bioRatios.cyrillic > 0.2
                             || bioRatios.thai     > 0.2 || bioRatios.deva     > 0.2;
        const bioIsLatinOnly = bioRatios.latin > 0.6 && bioIsNonJP;

        if (bioIsNonJP && (bioHasForeign || bioIsLatinOnly)) {
          let bioLabel = '🌐 海外プロフィール';
          if      (bioRatios.arabic   > 0.2) bioLabel = '🇸🇦 アラビア語プロフィール';
          else if (bioRatios.cyrillic > 0.2) bioLabel = '🇷🇺 キリル文字プロフィール';
          else if (bioRatios.thai     > 0.2) bioLabel = '🇹🇭 タイ語プロフィール';
          else if (bioRatios.deva     > 0.2) bioLabel = '🇮🇳 デヴァナーガリープロフィール';
          else if (bioIsLatinOnly)           bioLabel = '🇺🇸 英語プロフィール';
          add(3, bioLabel);
        }
      }
    }

    // ------------------------------------------------------------------
    // B. 【AI生成日本語判定】
    // ------------------------------------------------------------------
    if (hasJapanese(tweetText)) {

      // B-1. パターン完全一致
      if (AI_JP_PATTERNS.some(p => p.test(tweetText))) {
        add(2, '🤖 AI定型文（パターン一致）');
      }

      // B-2. AI頻出語彙チェック（複数該当でスコア加算）
      const vocabHits = AI_JP_VOCAB.filter(v => tweetText.includes(v));
      if (vocabHits.length >= 2) {
        add(2, `🤖 AI語彙（${vocabHits.slice(0,2).join('/')}）`);
      } else if (vocabHits.length === 1) {
        add(1, `🤖 AI語彙（${vocabHits[0]}）`);
      }

      // B-3. 文体の不自然さ：過剰な敬語＋絵文字なし＋句読点過多
      const formalCount = (tweetText.match(/(ございます|いたします|させていただき|おります|申し上げ)/g)||[]).length;
      const emojiCount  = (tweetText.match(/\p{Emoji_Presentation}/gu)||[]).length;
      if (formalCount >= 2 && emojiCount === 0 && tweetText.length < 120) {
        add(1, '📝 過剰敬語・ロボ文体');
      }

      // B-4. 実際の日本人ユーザーが使わない表現
      const unnaturalJP = [
        /情報(を|を)?(シェア|共有)(して|いただき)?(ありがとう|感謝)/,
        /このような(素晴らしい|貴重な|有益な)/,
        /(深い|鋭い)(洞察|知見|分析|考察)(を|が)?(ありがとう|感謝|共有)/,
        /知識(を|が)?(深め|広め)(られ|ることが)(ます|ました)/,
        /このような(機会|場)(を|に)?(いただき|設けていただき)/,
        /お互い(に)?(成長|学び|高め合)(いましょう|合いましょう)/,
        /引き続き(素晴らしい|良い)(発信|情報提供)(を|よろしく)/,
      ];
      if (unnaturalJP.some(p => p.test(tweetText))) {
        add(2, '🗾 不自然な日本語表現');
      }

      // B-5. 短すぎる「お世辞」コメント（日本語）
      if (tweetText.length <= 30 && AI_JP_PATTERNS.some(p => p.test(tweetText))) {
        add(1, '💬 短い称賛コメント');
      }

      // B-6. ハンドルが非日本語なのに日本語で返信（組み合わせ）
      if (!hasJapanese(handle) && /\d{4,}/.test(handle)) {
        add(1, '⚠️ 海外ハンドル＋日本語偽装');
      }
    }

    // ------------------------------------------------------------------
    // C. 【共通スパム判定】
    // ------------------------------------------------------------------

    // C-1. 絵文字のみ
    const textNoEmoji = tweetText.replace(/\p{Emoji_Presentation}/gu, '').trim();
    if (tweetText.length > 0 && textNoEmoji.length === 0) {
      add(2, '😂 絵文字のみ');
    }

    // C-2. 同じ文字・記号の繰り返し
    if (/(.)\1{5,}/.test(tweetText)) {
      add(1, '🔁 文字繰り返し');
    }

    // C-3. リンクのみ（本文ゼロ）
    const hasLinkCard = !!article.querySelector('[data-testid="card.wrapper"]');
    if (hasLinkCard && tweetText.length === 0) {
      add(1, '🔗 リンクカードのみ');
    }

    // C-4. ハッシュタグ羅列（本文の半分以上がハッシュタグ）
    const hashMatches = tweetText.match(/#\S+/g) || [];
    if (hashMatches.length >= 3 && hashMatches.join('').length / tweetText.length > 0.5) {
      add(1, '#️⃣ ハッシュタグ羅列');
    }

    // C-5. エンゲージメント完全ゼロ
    const engNums = [...article.querySelectorAll('[data-testid$="-count"]')]
      .map(el => parseInt(el.textContent.replace(/[^0-9]/g, ''), 10) || 0);
    if (engNums.length > 0 && engNums.every(n => n === 0)) {
      add(1, '📊 エンゲージメント0');
    }

    // C-6. 同一アカウントが2回以上リプライ → +3（インプレ稼ぎの典型）
    if (handle) {
      handleReplyCount[handle] = (handleReplyCount[handle] || 0) + 1;
      if (handleReplyCount[handle] === 2) {
        // 2回目を検出した瞬間、1回目（既にスキャン済み）も遡って加点
        const prev = document.querySelector(
          `article[data-testid="tweet"][data-xzf-handle="${CSS.escape(handle)}"]`
        );
        if (prev && prev !== article) {
          const prevScore = parseInt(prev.dataset.xzfScore || '0', 10) + 3;
          prev.dataset.xzfScore = prevScore;
          const prevReasons = (prev.dataset.xzfReasons || '') + ', 🔄 複数回リプライ（遡及）';
          prev.dataset.xzfReasons = prevReasons;
          // まだ非表示になっていなければここで適用
          if (!prev.classList.contains('xzf-zombie-collapsed') && !prev.classList.contains('xzf-zombie-hidden')) {
            hiddenCount++;
            updatePanel();
            if (CONFIG.mode === 'hide') {
              prev.classList.add('xzf-zombie-hidden');
            } else {
              prev.classList.add('xzf-zombie-collapsed');
              attachOverlay(prev, '🔄 複数回リプライ（遡及）');
            }
          }
        }
        add(3, '🔄 複数回リプライ');
      } else if (handleReplyCount[handle] > 2) {
        add(3, `🔄 複数回リプライ（${handleReplyCount[handle]}回目）`);
      }
      // ハンドルをarticleに記録（遡及用）
      article.dataset.xzfHandle = handle;
    }

    if (CONFIG.debug) {
      console.log(`[XZF] score=${score}`, reasons, tweetText.slice(0, 60));
    }

    return { score, reasons };
  }

  // 現在のスレッドページが日本語ツイートかどうかを判定
  function isJapaneseThread() {
    // スレッドの親ツイート（最初の article）を確認
    const main = document.querySelector('article[data-testid="tweet"]');
    if (!main) return false;
    const mainText = main.querySelector('[data-testid="tweetText"]')?.textContent ?? '';
    return hasJapanese(mainText);
  }

  // =============================================
  //  DOM 操作
  // =============================================
  let hiddenCount = 0;
  let scannedCount = 0;
  let skipFirst = true; // 親ツイートをスキップするフラグ

  function getLabel(reasons) {
    const top = reasons[0] ?? '不審なツイート';
    return `⚠ ゾンビ疑い: ${top}`;
  }

  // オーバーレイdivを生成してarticleに挿入し、クリックでトグル
  function attachOverlay(article, label) {
    // 二重挿入防止
    if (article.querySelector('.xzf-overlay')) return;
    const overlay = document.createElement('div');
    overlay.className = 'xzf-overlay';
    overlay.innerHTML = `<span>⚠ ${label}（クリックで展開）</span>`;
    overlay.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const expanded = article.classList.toggle('xzf-expanded');
      overlay.querySelector('span').textContent = expanded
        ? '▲ 折りたたむ'
        : `⚠ ${label}（クリックで展開）`;
    });
    article.style.position = 'relative'; // 念のため
    article.appendChild(overlay);
  }

  function processArticle(article, index) {
    if (article.dataset.xzfScanned) return;
    article.dataset.xzfScanned = '1';

    // インデックス0は親ツイートなのでスキップ
    if (index === 0 && skipFirst) return;

    scannedCount++;

    const { score, reasons } = calcZombieScore(article);
    if (score < CONFIG.threshold) return;

    article.dataset.xzfScore = score;
    article.dataset.xzfReasons = reasons.join(', ');
    hiddenCount++;
    updatePanel();

    if (CONFIG.mode === 'hide') {
      article.classList.add('xzf-zombie-hidden');
    } else {
      const label = getLabel(reasons);
      article.classList.add('xzf-zombie-collapsed');
      attachOverlay(article, label);
    }
  }

  // /username/status/123456 の形式 = ツイート詳細（リプライ）ページのみ動作
  function isReplyPage() {
    return /^\/[^/]+\/status\/\d+/.test(location.pathname);
  }

  function scanAll() {
    if (!isReplyPage()) return; // タイムライン等では何もしない
    const articles = [...document.querySelectorAll('article[data-testid="tweet"]')];
    articles.forEach((a, i) => processArticle(a, i));
  }

  // =============================================
  //  UI パネル
  // =============================================
  function buildPanel() {
    const panel = document.createElement('div');
    panel.id = 'xzf-panel';
    panel.innerHTML = `
      <span class="xzf-icon">🧟</span>
      <div class="xzf-stat">
        <span class="val" id="xzf-scanned">0</span>
        <span>スキャン</span>
      </div>
      <div class="xzf-divider"></div>
      <div class="xzf-stat blocked">
        <span class="val" id="xzf-hidden">0</span>
        <span>ブロック</span>
      </div>
    `;
    document.body.appendChild(panel);

  }

  function updatePanel() {
    const s = document.getElementById('xzf-scanned');
    const h = document.getElementById('xzf-hidden');
    if (s) s.textContent = scannedCount;
    if (h) h.textContent = hiddenCount;
  }


  // =============================================
  //  MutationObserver（SPA対応）
  // =============================================
  let timer = null;
  const observer = new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      syncPanelVisibility();
      scanAll();
    }, CONFIG.debounceMs);
  });

  function init() {
    buildPanel();
    syncPanelVisibility();
    scanAll();
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // URLが変わるたびにパネル表示・スキャンを同期
  function syncPanelVisibility() {
    const panel = document.getElementById('xzf-panel');
    if (!panel) return;
    panel.style.display = isReplyPage() ? 'flex' : 'none';
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();