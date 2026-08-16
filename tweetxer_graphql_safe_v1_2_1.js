// ==UserScript==
// @name         TweetXer GraphQL Safe
// @namespace    local.x-cleaner
// @version      1.2.1
// @description  Conservative archive-based X DeleteTweet runner with persistent progress, milestone pauses, rate-limit backoff, and logging.
// @match        https://x.com/*
// @match        https://twitter.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(() => {
  if (window.__TWEETXER_GRAPHQL_SAFE_V12__) return;
  window.__TWEETXER_GRAPHQL_SAFE_V12__ = true;

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

  const STORAGE_KEY = 'tweetxer_graphql_safe_v1_2_state';

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

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const rand = (min, max) => Math.floor(min + Math.random() * (max - min + 1));

  function getCookie(name) {
    const m = (`; ${document.cookie}`).match(`;\\s*${name}=([^;]+)`);
    return m ? m[1] : null;
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

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        queue: S.queue,
        index: S.index,
        stats: S.stats,
        consecutive429s: S.consecutive429s,
        lastCompletedBatchMilestone: S.lastCompletedBatchMilestone,
        skipFirst: S.skipFirst,
        log: S.log,
        savedAt: Date.now()
      }));
    } catch (err) {
      console.warn('[TweetXer GraphQL Safe] save failed', err);
    }
  }

  function restoreState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;

      const p = JSON.parse(raw);
      if (!Array.isArray(p.queue) || !p.queue.length) return false;

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
      console.warn('[TweetXer GraphQL Safe] restore failed', err);
      return false;
    }
  }

  function clearState() {
    localStorage.removeItem(STORAGE_KEY);
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
    if (cutpoint < 0) throw new Error('Could not locate archive assignment.');

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

  function setStatus(msg, kind='normal') {
    const el = document.getElementById('txgs_status');
    if (!el) return;
    el.textContent = msg;
    el.className = kind;
  }

  function formatMs(ms) {
    const sec = Math.max(0, Math.ceil(ms / 1000));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return m ? `${m}m ${s}s` : `${s}s`;
  }

  function render() {
    const values = {
      total: S.stats.total,
      processed: S.stats.processed,
      ok: S.stats.http200,
      rl: S.stats.rateLimited,
      failed: S.stats.failed,
      current: S.queue[S.index] || '—'
    };

    for (const [key, val] of Object.entries(values)) {
      const el = document.getElementById(`txgs_${key}`);
      if (el) el.textContent = String(val);
    }

    const pauseEl = document.getElementById('txgs_pause_type');
    if (pauseEl) pauseEl.textContent = S.currentPauseType || 'none';

    const activityEl = document.getElementById('txgs_last_activity');
    if (activityEl) {
      const ageSec = Math.max(0, Math.floor((Date.now() - S.lastActivityAt) / 1000));
      activityEl.textContent =
        ageSec < 60 ? `${ageSec}s ago` : `${Math.floor(ageSec / 60)}m ago`;
    }

    const startingAtEl = document.getElementById('txgs_starting_at');
    if (startingAtEl) {
      startingAtEl.textContent =
        S.stats.total > 0 && S.index < S.stats.total
          ? String(S.index + 1)
          : '—';
    }

    const remainingEl = document.getElementById('txgs_remaining');
    if (remainingEl) {
      remainingEl.textContent =
        Math.max(0, S.stats.total - S.index).toLocaleString();
    }

    const skipEl = document.getElementById('txgs_skip');
    if (skipEl && document.activeElement !== skipEl) {
      skipEl.value = String(S.skipFirst || 0);
    }

    const p = document.getElementById('txgs_progress');
    if (p) {
      p.max = Math.max(1, S.stats.total);
      p.value = Math.min(S.stats.processed, S.stats.total);
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
    updateTransactionId();

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
        while (S.paused && !S.stopRequested) await sleep(500);
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
        }
        else {
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
          }
          else if (S.index < S.queue.length) {
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
      `tweetxer-graphql-results-${new Date().toISOString().replace(/[:.]/g,'-')}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function makeUI() {
    document.getElementById('txgs_panel')?.remove();

    const panel = document.createElement('div');
    panel.id = 'txgs_panel';
    panel.innerHTML = `
      <style>
        #txgs_panel {
          position: sticky;
          top: 0;
          z-index: 999999;
          background: rgba(240,248,255,.98);
          color: #111;
          border-bottom: 2px solid #1d9bf0;
          padding: 12px 16px;
          font-family: system-ui, sans-serif;
        }
        #txgs_panel .row {
          display: flex;
          gap: 8px;
          align-items: center;
          flex-wrap: wrap;
          margin: 6px 0;
        }
        #txgs_panel .stats span {
          background: #fff;
          border: 1px solid #ccd6dd;
          border-radius: 6px;
          padding: 5px 8px;
        }
        #txgs_panel button {
          border: 1px solid #536471;
          border-radius: 999px;
          padding: 6px 12px;
          cursor: pointer;
        }
        #txgs_panel button.primary {
          background: #1d9bf0;
          color: white;
          border-color: #1d9bf0;
        }
        #txgs_panel button:disabled {
          opacity: .5;
          cursor: not-allowed;
        }
        #txgs_panel #txgs_status {
          padding: 7px 9px;
          border-radius: 6px;
          background: #fff;
        }
        #txgs_panel #txgs_status.error {
          background: #ffe5e5;
          color: #8b0000;
          border: 1px solid #c62828;
          font-weight: 700;
        }
        #txgs_panel #txgs_status.success {
          background: #eaf7ea;
          color: #185b18;
          border: 1px solid #78a878;
        }
        #txgs_panel progress {
          width: 100%;
          height: 16px;
        }
        #txgs_panel small {
          color: #536471;
        }
      </style>

      <h2>TweetXer GraphQL Safe v1.2.1</h2>

      <div class="row">
        <label><strong>Tweet headers:</strong></label>
        <input id="txgs_headers_file" type="file" accept=".js">
        <small>must be <code>tweet-headers.js</code></small>
      </div>

      <div class="row">
        <label><strong>Tweets archive:</strong></label>
        <input id="txgs_tweets_file" type="file" accept=".js">
        <small>must be <code>tweets.js</code></small>
      </div>

      <div class="row">
        <label for="txgs_skip"><strong>Skip first IDs:</strong></label>
        <input id="txgs_skip" type="number" min="0" step="1" value="0" style="width:110px">
        <span>Starting at: <strong id="txgs_starting_at">1</strong></span>
        <span>Remaining: <strong id="txgs_remaining">0</strong></span>
      </div>

      <div class="row">
        <button id="txgs_start" class="primary" disabled>Start / Resume</button>
        <button id="txgs_pause">Pause</button>
        <button id="txgs_stop">Stop</button>
        <button id="txgs_export">Export log</button>
        <button id="txgs_reset">Reset progress</button>
      </div>

      <div class="row stats">
        <span>Total <strong id="txgs_total">0</strong></span>
        <span>Processed <strong id="txgs_processed">0</strong></span>
        <span>HTTP 200 <strong id="txgs_ok">0</strong></span>
        <span>429 <strong id="txgs_rl">0</strong></span>
        <span>Failed <strong id="txgs_failed">0</strong></span>
      </div>

      <progress id="txgs_progress" value="0" max="1"></progress>

      <div class="row">
        <strong>Current:</strong>
        <code id="txgs_current">—</code>
        <span>Pause: <strong id="txgs_pause_type">none</strong></span>
        <span>Last activity: <strong id="txgs_last_activity">now</strong></span>
      </div>

      <div id="txgs_status">
        Import tweet-headers.js or tweets.js. Start stays disabled until IDs are loaded.
      </div>

      <small>
        Defaults: random ${CFG.minDelayMs/1000}-${CFG.maxDelayMs/1000}s delay,
        ${CFG.batchPauseMs/60000}-minute pause at each ${CFG.batchSize}-HTTP-200 milestone,
        and stop after ${CFG.max429sBeforeStop} HTTP 429 responses.
        You can skip the first X archive IDs before starting. Progress is saved locally.
        Batch pauses use wall-clock time so browser timer throttling
        should not stretch a 10-minute pause into hours. HTTP 200 means X accepted the GraphQL request;
        this script does not independently verify deletion.
      </small>
    `;

    document.body.insertBefore(panel, document.body.firstChild);

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

        S.queue = ids;

        const skipInput = document.getElementById('txgs_skip');
        const requestedSkip = Math.max(
          0,
          Math.min(
            ids.length,
            Math.floor(Number(skipInput?.value || 0))
          )
        );

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

        const startBtn = document.getElementById('txgs_start');
        if (startBtn) startBtn.disabled = false;

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

    document
      .getElementById('txgs_headers_file')
      .addEventListener('change', ev =>
        importArchiveFile(ev.target.files?.[0], 'tweet-headers.js')
      );

    document
      .getElementById('txgs_tweets_file')
      .addEventListener('change', ev =>
        importArchiveFile(ev.target.files?.[0], 'tweets.js')
      );

    document.getElementById('txgs_skip').addEventListener('change', ev => {
      if (S.running || S.stats.processed > 0) {
        ev.target.value = String(S.skipFirst || 0);
        setStatus(
          'Skip amount is locked after processing begins. Use Reset progress to choose a new skip amount.',
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

    document.getElementById('txgs_start').addEventListener('click', () => {
      const skipInput = document.getElementById('txgs_skip');
      if (skipInput) skipInput.disabled = true;

      S.paused = false;
      S.stopRequested = false;
      setPauseType('none');
      touchActivity();
      runQueue();
    });

    document.getElementById('txgs_pause').addEventListener('click', () => {
      S.paused = true;
      setPauseType('user');
      touchActivity();
      setStatus('User pause requested. Current request will finish first.');
    });

    document.getElementById('txgs_stop').addEventListener('click', () => {
      S.stopRequested = true;
      S.paused = false;
      setPauseType('stopped');
      touchActivity();
      setStatus('Stop requested. Current request will finish first.', 'error');
    });

    document.getElementById('txgs_export').addEventListener('click', exportLog);

    document.getElementById('txgs_reset').addEventListener('click', () => {
      if (!confirm('Reset saved queue, counters, and progress?')) return;
      clearState();
      location.reload();
    });
  }

  function init() {
    S.ct0 = getCookie('ct0') || '';
    S.username = location.pathname.split('/')[1] || '';

    const restored = restoreState();

    makeUI();

    const startBtn = document.getElementById('txgs_start');
    if (startBtn) startBtn.disabled = !S.queue.length;

    const skipInput = document.getElementById('txgs_skip');
    if (skipInput) {
      skipInput.value = String(S.skipFirst || 0);
      skipInput.disabled = Boolean(restored && S.stats.processed > 0);
    }

    if (restored) {
      setStatus(
        `Restored ${S.index.toLocaleString()} / ${S.queue.length.toLocaleString()} position. Press Start / Resume to continue.`,
        'success'
      );
    }

    render();

    setInterval(() => {
      render();
      saveState();
    }, 5000);
  }

  setTimeout(init, 1000);
})();
