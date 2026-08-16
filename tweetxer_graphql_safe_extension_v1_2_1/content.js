(() => {
  if (window.__TWEETXER_GRAPHQL_SAFE_EXTENSION__) return;
  window.__TWEETXER_GRAPHQL_SAFE_EXTENSION__ = true;

  const CFG = {
    minDelayMs: 2500,
    maxDelayMs: 6500,
    batchSize: 75,
    batchPauseMs: 10 * 60 * 1000,
    rateLimitExtraMinMs: 30 * 1000,
    rateLimitExtraMaxMs: 90 * 1000,
    fallback429PauseMs: 15 * 60 * 1000,
    max429sBeforeStop: 2,
    requestTimeoutMs: 10000,
    deleteURL: '/i/api/graphql/VaenaVgh5q5ih7kvyVjgtg/DeleteTweet',
    authorization:
      'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA'
  };

  const STORAGE_KEY = 'tweetxerGraphqlSafeStateV1';

  const S = {
    queue: [],
    index: 0,
    running: false,
    paused: false,
    stopRequested: false,
    ct0: '',
    username: '',
    transactionId: '',
    consecutive429s: 0,
    lastCompletedBatchMilestone: 0,
    skipFirst: 0,
    currentPauseType: 'none',
    lastActivityAt: Date.now(),
    stats: {
      total: 0,
      processed: 0,
      http200: 0,
      rateLimited: 0,
      failed: 0
    },
    log: []
  };

  let shadow = null;

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const rand = (min, max) => Math.floor(min + Math.random() * (max - min + 1));

  function $(id) {
    return shadow?.getElementById(id) || null;
  }

  function getCookie(name) {
    const match = (`; ${document.cookie}`).match(`;\\s*${name}=([^;]+)`);
    return match ? match[1] : null;
  }

  function updateTransactionId() {
    S.transactionId = [...crypto.getRandomValues(new Uint8Array(95))]
      .map((x) => {
        const i = x / 255 * 61 | 0;
        return String.fromCharCode(i + (i > 9 ? i > 35 ? 61 : 55 : 48));
      })
      .join('');
  }

  function nowISO() {
    return new Date().toISOString();
  }

  async function saveState() {
    try {
      await chrome.storage.local.set({
        [STORAGE_KEY]: {
          queue: S.queue,
          index: S.index,
          stats: S.stats,
          consecutive429s: S.consecutive429s,
          lastCompletedBatchMilestone: S.lastCompletedBatchMilestone,
          skipFirst: S.skipFirst,
          log: S.log,
          savedAt: Date.now()
        }
      });
    } catch (err) {
      console.warn('[TweetXer GraphQL Safe - Extension] save failed', err);
    }
  }

  async function restoreState() {
    try {
      const stored = await chrome.storage.local.get(STORAGE_KEY);
      const p = stored?.[STORAGE_KEY];
      if (!p || !Array.isArray(p.queue) || !p.queue.length) return false;

      S.queue = p.queue;
      S.index = Number(p.index || 0);
      S.stats = p.stats || S.stats;
      S.consecutive429s = Number(p.consecutive429s || 0);
      S.lastCompletedBatchMilestone = Number(p.lastCompletedBatchMilestone || 0);
      S.skipFirst = Number(p.skipFirst || 0);
      S.log = Array.isArray(p.log) ? p.log : [];
      S.paused = true;
      S.running = false;
      S.stopRequested = false;
      S.currentPauseType = 'none';
      S.lastActivityAt = Date.now();
      return true;
    } catch (err) {
      console.warn('[TweetXer GraphQL Safe - Extension] restore failed', err);
      return false;
    }
  }

  async function clearState() {
    await chrome.storage.local.remove(STORAGE_KEY);
  }

  function touchActivity() {
    S.lastActivityAt = Date.now();
    saveState();
  }

  function setPauseType(type) {
    S.currentPauseType = type;
    saveState();
    render();
  }

  function logResult(entry) {
    S.log.push({ timestamp: nowISO(), ...entry });
    touchActivity();
    render();
  }

  function parseArchive(text, fileName) {
    const cutpoint = text.indexOf('= ');
    if (cutpoint < 0) {
      throw new Error('Could not locate archive assignment.');
    }

    const prefix = text.slice(0, cutpoint);
    const data = JSON.parse(text.slice(cutpoint + 2));

    if (fileName === 'tweet-headers.js') {
      if (!prefix.includes('.tweet_headers.')) {
        throw new Error('Selected file is not tweet-headers.js content.');
      }
      return data.map(x => String(x?.tweet?.tweet_id || '')).filter(Boolean);
    }

    if (fileName === 'tweets.js') {
      if (!(prefix.includes('.tweets.') || prefix.includes('.tweet.'))) {
        throw new Error('Selected file is not tweets.js content.');
      }
      return data.map(x => String(x?.tweet?.id_str || '')).filter(Boolean);
    }

    throw new Error('Only tweet-headers.js or tweets.js is supported.');
  }

  function uniqueIds(ids) {
    return [...new Set(ids.filter(id => /^\d+$/.test(id)))];
  }

  function setStatus(message, kind='normal') {
    const el = $('status');
    if (!el) return;
    el.textContent = message;
    el.dataset.kind = kind;
  }

  function formatMs(ms) {
    const sec = Math.max(0, Math.ceil(ms / 1000));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return m ? `${m}m ${s}s` : `${s}s`;
  }

  function render() {
    const map = {
      total: S.stats.total,
      processed: S.stats.processed,
      http200: S.stats.http200,
      rateLimited: S.stats.rateLimited,
      failed: S.stats.failed,
      current: S.queue[S.index] || '—'
    };

    for (const [key, value] of Object.entries(map)) {
      const el = $(key);
      if (el) el.textContent = String(value);
    }

    const startingAt = $('startingAt');
    if (startingAt) {
      startingAt.textContent =
        S.stats.total > 0 && S.index < S.stats.total
          ? String(S.index + 1)
          : '—';
    }

    const remaining = $('remaining');
    if (remaining) {
      remaining.textContent =
        Math.max(0, S.stats.total - S.index).toLocaleString();
    }

    const skip = $('skip');
    if (skip && document.activeElement !== skip) {
      skip.value = String(S.skipFirst || 0);
    }

    const pauseType = $('pauseType');
    if (pauseType) pauseType.textContent = S.currentPauseType || 'none';

    const lastActivity = $('lastActivity');
    if (lastActivity) {
      const age = Math.max(0, Math.floor((Date.now() - S.lastActivityAt) / 1000));
      lastActivity.textContent =
        age < 60 ? `${age}s ago` : `${Math.floor(age / 60)}m ago`;
    }

    const progress = $('progress');
    if (progress) {
      progress.max = Math.max(1, S.stats.total);
      progress.value = Math.min(S.index, S.stats.total);
    }

    const start = $('start');
    if (start) start.disabled = !S.queue.length;

    const skipInput = $('skip');
    if (skipInput) {
      skipInput.disabled = Boolean(S.running || S.stats.processed > 0);
    }
  }

  async function waitCountdown(ms, prefix, pauseType='timer') {
    const endAt = Date.now() + ms;
    setPauseType(pauseType);

    while (Date.now() < endAt) {
      if (S.stopRequested) {
        setPauseType('none');
        return false;
      }

      if (S.paused) {
        setPauseType('user');
        setStatus('User paused.');

        while (S.paused && !S.stopRequested) {
          await sleep(500);
        }

        if (S.stopRequested) {
          setPauseType('none');
          return false;
        }

        setPauseType(pauseType);
      }

      const remaining = Math.max(0, endAt - Date.now());
      setStatus(`${prefix} ${formatMs(remaining)} remaining…`);
      await sleep(Math.min(1000, Math.max(100, remaining)));
    }

    setPauseType('none');
    touchActivity();
    return true;
  }

  async function waitNormalDelay() {
    return await waitCountdown(
      rand(CFG.minDelayMs, CFG.maxDelayMs),
      'Next request in',
      'normal-delay'
    );
  }

  function get429Wait(headers) {
    const reset = headers?.reset;
    if (!reset) return CFG.fallback429PauseMs;

    const resetMs = Number(reset) * 1000;
    if (!Number.isFinite(resetMs)) return CFG.fallback429PauseMs;

    const extra = rand(CFG.rateLimitExtraMinMs, CFG.rateLimitExtraMaxMs);
    return Math.max(60 * 1000, resetMs - Date.now() + extra);
  }

  async function deleteOne(tweetId) {
    S.ct0 = getCookie('ct0') || S.ct0;
    updateTransactionId();

    if (!S.ct0) {
      return {
        status: 0,
        ok: false,
        error: 'ct0 CSRF cookie not found. Reload X and make sure you are logged in.',
        headers: {}
      };
    }

    const body = JSON.stringify({
      variables: {
        tweet_id: tweetId,
        dark_request: false
      },
      queryId: CFG.deleteURL.split('/')[6]
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CFG.requestTimeoutMs);

    try {
      const response = await fetch(location.origin + CFG.deleteURL, {
        headers: {
          authorization: CFG.authorization,
          'content-type': 'application/json',
          'x-client-transaction-id': S.transactionId,
          'x-csrf-token': S.ct0,
          'x-twitter-active-user': 'yes',
          'x-twitter-auth-type': 'OAuth2Session'
        },
        referrer: `${location.origin}/${S.username}/with_replies`,
        referrerPolicy: 'strict-origin-when-cross-origin',
        body,
        method: 'POST',
        mode: 'cors',
        credentials: 'include',
        signal: controller.signal
      });

      clearTimeout(timeout);

      let payload = null;
      try {
        payload = await response.clone().json();
      } catch {
        try {
          payload = await response.clone().text();
        } catch {
          payload = null;
        }
      }

      return {
        status: response.status,
        ok: response.ok,
        payload,
        headers: {
          remaining: response.headers.get('x-rate-limit-remaining'),
          reset: response.headers.get('x-rate-limit-reset')
        }
      };
    } catch (err) {
      clearTimeout(timeout);
      return {
        status: 0,
        ok: false,
        error: String(err?.message || err),
        headers: {}
      };
    }
  }

  async function runQueue() {
    if (S.running) return;

    if (!S.queue.length) {
      setStatus('Import tweet-headers.js or tweets.js first.', 'error');
      return;
    }

    S.running = true;
    S.stopRequested = false;
    S.paused = false;
    setPauseType('none');
    touchActivity();

    while (S.index < S.queue.length && !S.stopRequested) {
      if (S.paused) {
        setPauseType('user');
        setStatus('User paused.');

        while (S.paused && !S.stopRequested) {
          await sleep(500);
        }

        if (S.stopRequested) break;
        setPauseType('none');
      }

      const tweetId = S.queue[S.index];
      render();
      touchActivity();
      setStatus(`Deleting ${tweetId}…`);

      const result = await deleteOne(tweetId);

      if (result.status === 200) {
        S.stats.http200++;
        S.stats.processed++;
        S.consecutive429s = 0;

        logResult({
          tweet_id: tweetId,
          outcome: 'http_200',
          http_status: 200,
          response: result.payload,
          rate_limit_remaining: result.headers.remaining ?? '',
          rate_limit_reset: result.headers.reset ?? ''
        });

        S.index++;
        touchActivity();
        render();

        if (
          result.headers.remaining !== null &&
          result.headers.remaining !== undefined &&
          result.headers.remaining !== '' &&
          Number(result.headers.remaining) <= 0
        ) {
          const ok = await waitCountdown(
            get429Wait(result.headers),
            'Rate limit exhausted. Waiting',
            'rate-limit'
          );
          if (!ok) break;
        } else {
          const milestone =
            Math.floor(S.stats.http200 / CFG.batchSize) * CFG.batchSize;

          if (
            milestone > 0 &&
            milestone > S.lastCompletedBatchMilestone &&
            S.index < S.queue.length
          ) {
            const ok = await waitCountdown(
              CFG.batchPauseMs,
              `Batch pause after ${milestone} HTTP 200s. Waiting`,
              'batch'
            );
            if (!ok) break;

            S.lastCompletedBatchMilestone = milestone;
            touchActivity();
          } else if (S.index < S.queue.length) {
            const ok = await waitNormalDelay();
            if (!ok) break;
          }
        }

        continue;
      }

      if (result.status === 429) {
        S.stats.rateLimited++;
        S.consecutive429s++;

        logResult({
          tweet_id: tweetId,
          outcome: 'rate_limited',
          http_status: 429,
          response: result.payload,
          rate_limit_remaining: result.headers.remaining ?? '',
          rate_limit_reset: result.headers.reset ?? ''
        });

        if (S.consecutive429s >= CFG.max429sBeforeStop) {
          setPauseType('rate-limit-stop');
          setStatus(
            `Stopped after ${S.consecutive429s} HTTP 429 responses. Resume later.`,
            'error'
          );
          S.stopRequested = true;
          break;
        }

        const ok = await waitCountdown(
          get429Wait(result.headers),
          '429 received. Waiting',
          'rate-limit'
        );
        if (!ok) break;

        continue;
      }

      S.stats.failed++;
      S.stats.processed++;

      logResult({
        tweet_id: tweetId,
        outcome: 'failed',
        http_status: result.status,
        response: result.payload ?? result.error ?? ''
      });

      S.index++;
      touchActivity();
      render();

      if (S.index < S.queue.length) {
        const ok = await waitNormalDelay();
        if (!ok) break;
      }
    }

    S.running = false;

    if (S.index >= S.queue.length) {
      setPauseType('finished');
      setStatus('Finished.', 'success');
    } else if (S.stopRequested) {
      if (S.currentPauseType !== 'rate-limit-stop') setPauseType('stopped');
      setStatus('Stopped.', 'error');
    } else if (S.paused) {
      setPauseType('user');
      setStatus('User paused.');
    }

    touchActivity();
    render();
  }

  function exportLog() {
    const blob = new Blob(
      [JSON.stringify(S.log, null, 2)],
      { type: 'application/json' }
    );

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download =
      `tweetxer-graphql-safe-results-${new Date().toISOString().replace(/[:.]/g,'-')}.json`;
    document.documentElement.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  async function importArchiveFile(file, expectedName) {
    if (!file) return;

    try {
      const actualName = String(file.name || '').toLowerCase();

      if (actualName !== expectedName) {
        throw new Error(
          `WRONG FILE — Expected ${expectedName}, but you selected "${file.name}".`
        );
      }

      setStatus(`Importing ${expectedName}…`);

      const text = await file.text();
      const ids = uniqueIds(parseArchive(text, expectedName));

      if (!ids.length) {
        throw new Error(`${expectedName} was read, but 0 numeric tweet IDs were found.`);
      }

      const skipInput = $('skip');
      const requestedSkip = Math.max(
        0,
        Math.min(
          ids.length,
          Math.floor(Number(skipInput?.value || 0))
        )
      );

      S.queue = ids;
      S.skipFirst = requestedSkip;
      S.index = requestedSkip;
      S.stats = {
        total: ids.length,
        processed: 0,
        http200: 0,
        rateLimited: 0,
        failed: 0
      };
      S.log = [];
      S.consecutive429s = 0;
      S.lastCompletedBatchMilestone = 0;
      S.currentPauseType = 'none';
      S.stopRequested = false;
      S.paused = false;
      touchActivity();

      setStatus(
        `READY — Loaded ${ids.length.toLocaleString()} unique IDs from ${expectedName}. ` +
        `Skipping first ${S.skipFirst.toLocaleString()}; starting at item ` +
        `${S.index < ids.length ? (S.index + 1).toLocaleString() : 'end of queue'}.`,
        'success'
      );

      render();
    } catch (err) {
      setStatus(String(err?.message || err), 'error');
    }
  }

  function buildPanel() {
    const host = document.createElement('div');
    host.id = 'tweetxer-graphql-safe-extension-host';
    host.style.position = 'sticky';
    host.style.top = '0';
    host.style.zIndex = '2147483647';

    shadow = host.attachShadow({ mode: 'open' });

    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .panel {
          background: rgba(240,248,255,.98);
          color: #111;
          border-bottom: 2px solid #1d9bf0;
          padding: 12px 16px;
          font-family: system-ui, sans-serif;
          line-height: 1.35;
        }
        h2 { margin: 0 0 8px; font-size: 21px; }
        .row {
          display: flex;
          gap: 8px;
          align-items: center;
          flex-wrap: wrap;
          margin: 6px 0;
        }
        .stats span {
          background: #fff;
          border: 1px solid #ccd6dd;
          border-radius: 6px;
          padding: 5px 8px;
        }
        button {
          border: 1px solid #536471;
          border-radius: 999px;
          padding: 6px 12px;
          cursor: pointer;
          background: #fff;
          color: #111;
          font-size: 14px;
        }
        button.primary {
          background: #1d9bf0;
          color: white;
          border-color: #1d9bf0;
        }
        button:disabled {
          opacity: .5;
          cursor: not-allowed;
        }
        input[type="number"] { width: 110px; }
        #status {
          padding: 7px 9px;
          border-radius: 6px;
          background: #fff;
          margin-top: 7px;
        }
        #status[data-kind="error"] {
          background: #ffe5e5;
          color: #8b0000;
          border: 1px solid #c62828;
          font-weight: 700;
        }
        #status[data-kind="success"] {
          background: #eaf7ea;
          color: #185b18;
          border: 1px solid #78a878;
        }
        progress {
          width: 100%;
          height: 16px;
        }
        small { color: #536471; }
        code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
      </style>

      <div class="panel">
        <h2>TweetXer GraphQL Safe - Extension v1.2.1</h2>

        <div class="row">
          <label><strong>Tweet headers:</strong></label>
          <input id="headersFile" type="file" accept=".js">
          <small>must be <code>tweet-headers.js</code></small>
        </div>

        <div class="row">
          <label><strong>Tweets archive:</strong></label>
          <input id="tweetsFile" type="file" accept=".js">
          <small>must be <code>tweets.js</code></small>
        </div>

        <div class="row">
          <label for="skip"><strong>Skip first IDs:</strong></label>
          <input id="skip" type="number" min="0" step="1" value="0">
          <span>Starting at: <strong id="startingAt">—</strong></span>
          <span>Remaining: <strong id="remaining">0</strong></span>
        </div>

        <div class="row">
          <button id="start" class="primary" disabled>Start / Resume</button>
          <button id="pause">Pause</button>
          <button id="stop">Stop</button>
          <button id="export">Export log</button>
          <button id="reset">Reset progress</button>
        </div>

        <div class="row stats">
          <span>Total <strong id="total">0</strong></span>
          <span>Processed <strong id="processed">0</strong></span>
          <span>HTTP 200 <strong id="http200">0</strong></span>
          <span>429 <strong id="rateLimited">0</strong></span>
          <span>Failed <strong id="failed">0</strong></span>
        </div>

        <progress id="progress" value="0" max="1"></progress>

        <div class="row">
          <strong>Current:</strong>
          <code id="current">—</code>
          <span>Pause: <strong id="pauseType">none</strong></span>
          <span>Last activity: <strong id="lastActivity">now</strong></span>
        </div>

        <div id="status">
          Import tweet-headers.js or tweets.js. Start stays disabled until IDs are loaded.
        </div>

        <small>
          Defaults: random ${CFG.minDelayMs/1000}-${CFG.maxDelayMs/1000}s delay,
          ${CFG.batchPauseMs/60000}-minute pause at each ${CFG.batchSize}-HTTP-200 milestone,
          stop after ${CFG.max429sBeforeStop} HTTP 429 responses.
          Progress is stored in chrome.storage.local.
        </small>
      </div>
    `;

    document.documentElement.prepend(host);

    $('headersFile').addEventListener('change', ev =>
      importArchiveFile(ev.target.files?.[0], 'tweet-headers.js')
    );

    $('tweetsFile').addEventListener('change', ev =>
      importArchiveFile(ev.target.files?.[0], 'tweets.js')
    );

    $('skip').addEventListener('change', ev => {
      if (S.running || S.stats.processed > 0) {
        ev.target.value = String(S.skipFirst || 0);
        setStatus(
          'Skip amount is locked after processing begins. Reset progress to choose a new skip.',
          'error'
        );
        return;
      }

      const max = S.queue.length || Number.MAX_SAFE_INTEGER;
      const value = Math.max(
        0,
        Math.min(max, Math.floor(Number(ev.target.value || 0)))
      );

      S.skipFirst = value;

      if (S.queue.length) {
        S.index = value;
        touchActivity();
        setStatus(
          `Skip set to ${value.toLocaleString()}. Next item will be ` +
          `${value < S.queue.length ? (value + 1).toLocaleString() : 'end of queue'}.`,
          'success'
        );
      }

      render();
    });

    $('start').addEventListener('click', () => {
      S.paused = false;
      S.stopRequested = false;
      setPauseType('none');
      touchActivity();
      runQueue();
    });

    $('pause').addEventListener('click', () => {
      S.paused = true;
      setPauseType('user');
      touchActivity();
      setStatus('User pause requested. Current request will finish first.');
    });

    $('stop').addEventListener('click', () => {
      S.stopRequested = true;
      S.paused = false;
      setPauseType('stopped');
      touchActivity();
      setStatus('Stop requested. Current request will finish first.', 'error');
    });

    $('export').addEventListener('click', exportLog);

    $('reset').addEventListener('click', async () => {
      if (!confirm('Reset saved queue, counters, log, and progress?')) return;
      await clearState();
      location.reload();
    });
  }

  async function init() {
    S.ct0 = getCookie('ct0') || '';
    S.username = location.pathname.split('/')[1] || '';

    const restored = await restoreState();

    buildPanel();

    if (restored) {
      setStatus(
        `Restored position ${S.index.toLocaleString()} / ${S.queue.length.toLocaleString()}. Press Start / Resume to continue.`,
        'success'
      );
    }

    render();

    setInterval(() => {
      render();
      saveState();
    }, 5000);
  }

  setTimeout(init, 800);
})();
