(function () {
  const NS = 'http://www.w3.org/2000/svg';
  function svgEl(tag, attrs) {
    const el = document.createElementNS(NS, tag);
    if (attrs) for (const k in attrs) el.setAttribute(k, attrs[k]);
    return el;
  }

  // ====================================================================
  //                  TOP TOOLBAR — "stack" skeleton
  // ====================================================================
  // Phase-1 wiring: mode tabs, mic toggle (placeholder), per-mode action
  // panels. Subsequent phases add real audio + calibration + routing.

  const toolbar = document.getElementById('mixerToolbar');
  const modeTabs = toolbar ? toolbar.querySelectorAll('.mode-tab') : [];
  const actionsEl = document.getElementById('modeActions');
  const bannerEl = document.getElementById('toolbarBanner');
  const micBtn = document.getElementById('micToggle');

  const CHANNEL_TAGS = ['V1','V2','V3','V4','V5','V6','V7','V8','KIK/V9','DRUM','KEYS','BASS'];

  // Application state. The "stack" of pending actions and the per-channel
  // calibration map both live here so subsequent phases can build on them.
  const state = {
    mode: 'performance',         // performance | calibration | routing
    mic: { live: false, level: -Infinity, err: null },
    calibration: {},             // ch tag → { calibrated, gainDb, hitAt }
    routing: {
      selectedPathEl: null,      // currently selected <path class="cable-*">
      addStep: null,             // null | 'pickSource' | 'pickDest'
      pendingSource: null,       // jack object during add cable workflow
      rerouteStep: false,        // true while waiting for a new destination
      customCables: [],          // [{ id, from, to, pathEl }]
    },
    actionStack: [],             // {type, payload} entries for undo
  };

  function setBanner(msg, kind) {
    if (!bannerEl) return;
    if (!msg) { bannerEl.hidden = true; bannerEl.innerHTML = ''; return; }
    bannerEl.hidden = false;
    bannerEl.innerHTML = msg;
    bannerEl.style.background = kind === 'error' ? '#7f1d1d' : '#78350f';
    bannerEl.style.borderLeftColor = kind === 'error' ? '#ef4444' : '#fbbf24';
    bannerEl.style.color = kind === 'error' ? '#fecaca' : '#fef3c7';
  }

  // Build per-mode action panels. Each returns an array of DOM nodes.
  const MODE_PANELS = {
    performance: () => {
      const hint = document.createElement('span');
      hint.className = 'toolbar-status';
      hint.textContent = 'Drag knobs, faders & switches. Click ▸ Match to snap to recommended settings.';
      return [hint];
    },
    calibration: () => {
      const out = [];
      const label = document.createElement('span');
      label.className = 'toolbar-label';
      label.textContent = 'Channel';
      out.push(label);

      const sel = document.createElement('select');
      sel.id = 'calibChannelSel';
      sel.className = 'toolbar-select';
      sel.appendChild(new Option('— pick —', ''));
      CHANNEL_TAGS.forEach((t) => {
        const opt = new Option(state.calibration[t] ? `${t} ✓` : t, t);
        sel.appendChild(opt);
      });
      // Restore previously-active session if any
      if (state.calibrationSession && state.calibrationSession.channel) sel.value = state.calibrationSession.channel;
      out.push(sel);

      const startBtn = document.createElement('button');
      startBtn.type = 'button';
      startBtn.id = 'calibStart';
      startBtn.className = 'toolbar-action-btn primary';
      startBtn.textContent = state.calibrationSession ? '■ Stop' : '▶ Start calibration';
      startBtn.disabled = !sel.value || !state.mic.live;
      out.push(startBtn);

      // Live readout pill (TOO QUIET / IN RANGE / TOO HOT + dB value)
      const readout = document.createElement('span');
      readout.id = 'calibReadout';
      readout.className = 'calib-readout';
      readout.innerHTML = '<span class="r-state">—</span><span class="r-db">−∞ dB</span>';
      out.push(readout);

      const status = document.createElement('span');
      status.id = 'calibStatus';
      status.className = 'toolbar-status';
      status.textContent = sel.value
        ? (state.calibration[sel.value]
            ? `${sel.value} calibrated · GAIN ${state.calibration[sel.value].gainDb.toFixed(1)} dB`
            : `ready → ${sel.value} (mic ${state.mic.live ? 'live' : 'not connected'})`)
        : 'pick a channel · target zone is −18 to −12 dBFS';
      out.push(status);

      const resetBtn = document.createElement('button');
      resetBtn.type = 'button';
      resetBtn.className = 'toolbar-action-btn';
      resetBtn.textContent = '⟲ Clear cal';
      resetBtn.disabled = !sel.value || !state.calibration[sel.value];
      resetBtn.addEventListener('click', () => {
        delete state.calibration[sel.value];
        removeCalibratedBadge(sel.value);
        renderActions();
      });
      out.push(resetBtn);

      sel.addEventListener('change', () => {
        startBtn.disabled = !sel.value || !state.mic.live;
        resetBtn.disabled = !sel.value || !state.calibration[sel.value];
        status.textContent = sel.value
          ? (state.calibration[sel.value]
              ? `${sel.value} calibrated · GAIN ${state.calibration[sel.value].gainDb.toFixed(1)} dB`
              : `ready → ${sel.value} (mic ${state.mic.live ? 'live' : 'not connected'})`)
          : 'pick a channel · target zone is −18 to −12 dBFS';
      });

      startBtn.addEventListener('click', () => {
        if (state.calibrationSession) {
          stopCalibration();
        } else {
          startCalibration(sel.value);
        }
      });

      return out;
    },
    routing: () => {
      const out = [];
      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.id = 'routingAdd';
      addBtn.className = 'toolbar-action-btn primary';
      addBtn.textContent = state.routing.addStep ? '✕ Cancel add' : '+ Add cable';
      out.push(addBtn);

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.id = 'routingRemove';
      removeBtn.className = 'toolbar-action-btn danger';
      removeBtn.textContent = '− Remove selected';
      removeBtn.disabled = !state.routing.selectedPathEl;
      out.push(removeBtn);

      const rerouteBtn = document.createElement('button');
      rerouteBtn.type = 'button';
      rerouteBtn.id = 'routingReroute';
      rerouteBtn.className = 'toolbar-action-btn';
      rerouteBtn.textContent = state.routing.rerouteStep ? '✕ Cancel reroute' : '↻ Reroute…';
      // Reroute is only meaningful on custom cables (we know their endpoints).
      const selIsCustom = state.routing.selectedPathEl &&
        state.routing.customCables.some((c) => c.pathEl === state.routing.selectedPathEl);
      rerouteBtn.disabled = !selIsCustom && !state.routing.rerouteStep;
      out.push(rerouteBtn);

      const undoBtn = document.createElement('button');
      undoBtn.type = 'button';
      undoBtn.id = 'routingUndo';
      undoBtn.className = 'toolbar-action-btn';
      undoBtn.textContent = '↶ Undo';
      undoBtn.disabled = state.actionStack.length === 0;
      out.push(undoBtn);

      const status = document.createElement('span');
      status.id = 'routingStatus';
      status.className = 'toolbar-status';
      let txt;
      if (state.routing.addStep === 'pickSource') {
        txt = 'click a SOURCE jack (yellow dots)';
        status.className = 'toolbar-status warn';
      } else if (state.routing.addStep === 'pickDest') {
        txt = `source = ${state.routing.pendingSource.label} · click a DESTINATION jack`;
        status.className = 'toolbar-status warn';
      } else if (state.routing.rerouteStep) {
        txt = 'click a NEW DESTINATION jack for the selected cable';
        status.className = 'toolbar-status warn';
      } else if (state.routing.selectedPathEl) {
        txt = selIsCustom
          ? 'custom cable selected · Remove or Reroute'
          : 'original cable selected · Remove (undo will restore it)';
        status.className = 'toolbar-status ok';
      } else {
        txt = `click a cable to select · custom cables: ${state.routing.customCables.length} · undo: ${state.actionStack.length}`;
      }
      status.textContent = txt;
      out.push(status);

      addBtn.addEventListener('click', () => {
        if (state.routing.addStep) cancelAdd(); else startAddCable();
      });
      removeBtn.addEventListener('click', () => removeSelectedCable());
      rerouteBtn.addEventListener('click', () => {
        if (state.routing.rerouteStep) cancelReroute(); else startReroute();
      });
      undoBtn.addEventListener('click', () => undoLastAction());

      return out;
    },
  };

  function renderActions() {
    if (!actionsEl) return;
    actionsEl.innerHTML = '';
    const nodes = MODE_PANELS[state.mode]();
    nodes.forEach((n) => actionsEl.appendChild(n));
  }

  function setMode(mode) {
    if (!MODE_PANELS[mode]) return;
    // Leaving calibration mid-session? Tear it down cleanly so the diagram
    // doesn't end up with a stale yellow outline or target highlight.
    if (state.mode === 'calibration' && mode !== 'calibration' && state.calibrationSession) {
      stopCalibration();
    }
    // Show/hide click-to-select hotspots on every channel strip
    if (mode === 'calibration') showChannelHotspots(); else hideChannelHotspots();
    // Leaving routing mode? Tear down hotspots, deselect, cancel pending.
    if (state.mode === 'routing' && mode !== 'routing') {
      exitRoutingMode();
    }
    state.mode = mode;
    modeTabs.forEach((t) => t.classList.toggle('active', t.dataset.mode === mode));
    renderActions();
    // Visual cue on diagram: outline body when calibration/routing is active
    const wrap = document.querySelector('.diagram-wrap');
    if (wrap) {
      wrap.style.boxShadow = mode === 'calibration'
        ? '0 0 0 2px #fbbf24 inset'
        : mode === 'routing'
        ? '0 0 0 2px #60a5fa inset'
        : 'none';
    }
    document.body.classList.toggle('routing-active', mode === 'routing');
    if (mode === 'routing') enterRoutingMode();
  }

  modeTabs.forEach((t) => t.addEventListener('click', () => setMode(t.dataset.mode)));

  // ====================================================================
  //              PHASE 2: live mic → LED meter (Web Audio)
  // ====================================================================
  // Captures the user's mic via getUserMedia, feeds it into an AnalyserNode,
  // and drives the LED meter + the toolbar level readout from peak dBFS.
  //
  // Notes for the operator:
  // - Browsers require a real origin: HTTPS or http://localhost. file:// is
  //   blocked silently in Chrome/Edge; the catch block surfaces a banner.
  // - We disable echoCancellation/noiseSuppression/autoGainControl so the
  //   meter reflects the raw mic level instead of the browser's AGC.
  // - Peak hold uses fast attack (instant) and slow release (~25 dB/s) so
  //   the LEDs are readable instead of flickering.

  const meterLeds = document.querySelectorAll('.meter-led');
  // Pre-group LEDs by channel and sort by threshold (lowest first) so we
  // can walk them once per frame instead of querying every tick.
  const ledsByCh = { L: [], R: [] };
  meterLeds.forEach((el) => {
    const ch = el.dataset.ch;
    const db = parseFloat(el.dataset.db);
    if (ledsByCh[ch]) ledsByCh[ch].push({ el, db });
  });
  ledsByCh.L.sort((a, b) => a.db - b.db);
  ledsByCh.R.sort((a, b) => a.db - b.db);

  function paintMeter(peakL, peakR) {
    for (const { el, db } of ledsByCh.L) el.classList.toggle('lit', peakL >= db);
    for (const { el, db } of ledsByCh.R) el.classList.toggle('lit', peakR >= db);
  }

  function fmtDb(v) {
    if (!isFinite(v) || v < -90) return '−∞';
    return (v > 0 ? '+' : '') + v.toFixed(1).replace(/\.0$/, '') + ' dB';
  }

  // micSession holds the live AudioContext + stream so we can tear it down
  // on toggle-off. Null when nothing is running.
  let micSession = null;

  async function startMic() {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 2,
      },
    });
    // AudioContext sample rate matches the device's default (usually 48 kHz)
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const src = ctx.createMediaStreamSource(stream);
    const splitter = ctx.createChannelSplitter(2);
    src.connect(splitter);

    function buildAnalyser() {
      const a = ctx.createAnalyser();
      a.fftSize = 2048;
      a.smoothingTimeConstant = 0;
      return a;
    }
    const aL = buildAnalyser();
    const aR = buildAnalyser();
    splitter.connect(aL, 0);
    splitter.connect(aR, 1);

    const bufL = new Float32Array(aL.fftSize);
    const bufR = new Float32Array(aR.fftSize);

    // Peak-hold state (per channel). Attack is instant (we always raise),
    // release decays at ~25 dB/s so the LEDs are readable.
    let holdL = -Infinity, holdR = -Infinity;
    let lastTs = performance.now();
    let rafId = 0;

    function tick(ts) {
      const dt = Math.max(0, (ts - lastTs) / 1000);
      lastTs = ts;
      aL.getFloatTimeDomainData(bufL);
      aR.getFloatTimeDomainData(bufR);

      let peakLraw = 0, peakRraw = 0;
      for (let i = 0; i < bufL.length; i++) {
        const aL_v = Math.abs(bufL[i]);
        const aR_v = Math.abs(bufR[i]);
        if (aL_v > peakLraw) peakLraw = aL_v;
        if (aR_v > peakRraw) peakRraw = aR_v;
      }
      const dbL = peakLraw > 0 ? 20 * Math.log10(peakLraw) : -Infinity;
      const dbR = peakRraw > 0 ? 20 * Math.log10(peakRraw) : -Infinity;

      // Attack instant, release at 25 dB/s
      holdL = dbL > holdL ? dbL : Math.max(holdL - 25 * dt, -90);
      holdR = dbR > holdR ? dbR : Math.max(holdR - 25 * dt, -90);

      paintMeter(holdL, holdR);
      const peak = Math.max(holdL, holdR);
      state.mic.level = peak;
      const lvlEl = micBtn && micBtn.querySelector('.mic-level');
      if (lvlEl) lvlEl.textContent = fmtDb(peak);

      // Inform calibration mode if it's open and tracking a channel
      if (state.mode === 'calibration' && calibTick) calibTick(peak);

      rafId = requestAnimationFrame(tick);
    }
    rafId = requestAnimationFrame(tick);

    return {
      stream, ctx,
      stop() {
        cancelAnimationFrame(rafId);
        try { stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
        try { ctx.close(); } catch (_) {}
        paintMeter(-Infinity, -Infinity);
      },
    };
  }

  // ====================================================================
  //              PHASE 3: calibration mode
  // ====================================================================
  // Workflow:
  //   1. Operator routes the channel-under-test (mixer DIRECT OUT / AUX /
  //      bus) into the laptop input. Browser sees that signal as "mic".
  //   2. Operator picks the channel tag and clicks Start.
  //   3. Loop watches peak dBFS each frame, classifies as QUIET/OK/HOT,
  //      and accumulates time-in-target. After 2 s in target → calibrated.
  //   4. Calibrated state stores the strip's GAIN knob value at completion
  //      so the operator has a record of what was set.

  const CALIB_TARGET_LOW  = -18;
  const CALIB_TARGET_HIGH = -12;
  const CALIB_HOLD_MS     = 2000;

  // Highlight the meter LEDs whose threshold sits inside the target window
  // so the operator can see exactly where to aim the meter.
  function setMeterTarget(on) {
    meterLeds.forEach((el) => {
      const db = parseFloat(el.dataset.db);
      const inTarget = db <= CALIB_TARGET_HIGH && db >= CALIB_TARGET_LOW;
      el.classList.toggle('target', on && inTarget);
    });
  }

  // Add/remove the pulsing yellow outline + per-channel ✓ badge on the
  // mixer SVG. Both live inside #calibOverlay so they're easy to manage.
  const calibOverlay = document.getElementById('calibOverlay');

  function findStripByTag(tag) {
    return stripObjs && stripObjs.find((o) => o.s.tag === tag);
  }

  function showActiveOutline(tag) {
    if (!calibOverlay) return;
    removeActiveOutline();
    const obj = findStripByTag(tag);
    if (!obj) return;
    const isStereo = obj.s.x >= 215;
    const width = isStereo ? 44 : 26;
    // Outline the scribble strip rect at y=99 (mixer-local), height 14.
    const r = svgEl('rect', {
      id: 'calibActiveOutline',
      x: (obj.s.x - width / 2).toFixed(1),
      y: 97.5,
      width: width.toFixed(1),
      height: 17,
      rx: 2,
      fill: 'none',
      stroke: '#fbbf24',
      'stroke-width': 1.5,
    });
    r.setAttribute('style', 'animation: calPulse 0.9s ease-in-out infinite');
    calibOverlay.appendChild(r);
  }
  function removeActiveOutline() {
    const r = document.getElementById('calibActiveOutline');
    if (r && r.parentNode) r.parentNode.removeChild(r);
  }

  function showCalibratedBadge(tag) {
    if (!calibOverlay) return;
    removeCalibratedBadge(tag);
    const obj = findStripByTag(tag);
    if (!obj) return;
    const isStereo = obj.s.x >= 215;
    const cx = obj.s.x + (isStereo ? 19 : 10);
    const g = svgEl('g', {
      class: 'strip-calibrated',
      'data-cal-tag': tag,
      transform: `translate(${cx}, 95)`,
    });
    g.appendChild(svgEl('circle', { cx: 0, cy: 0, r: 4 }));
    const t = svgEl('text', { x: 0, y: 2 });
    t.textContent = '✓';
    g.appendChild(t);
    calibOverlay.appendChild(g);
  }
  function removeCalibratedBadge(tag) {
    const existing = calibOverlay && calibOverlay.querySelector(`[data-cal-tag="${tag}"]`);
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
  }

  // Channel-strip click hotspots — only shown while Calibration mode is active.
  // Clicking one picks that channel in the dropdown and fires its change event.
  function showChannelHotspots() {
    if (!calibOverlay) return;
    calibOverlay.querySelectorAll('.ch-hotspot').forEach((el) => el.remove());
    STRIPS.forEach((s) => {
      const isStereo = s.x >= 215;
      const width = isStereo ? 42 : 23;
      const hot = svgEl('rect', {
        class: 'ch-hotspot',
        x: (s.x - width / 2).toFixed(1),
        y: 97,
        width: width.toFixed(1),
        height: 20,
        rx: 2,
        'data-ch-tag': s.tag,
        'pointer-events': 'all',
      });
      hot.addEventListener('click', (ev) => {
        ev.stopPropagation();
        calibOverlay.querySelectorAll('.ch-hotspot').forEach((el) => el.classList.remove('selected'));
        hot.classList.add('selected');
        // Reflect into the dropdown so the rest of the calibration UI stays in sync.
        const sel = document.getElementById('calibChannelSel');
        if (sel) {
          sel.value = s.tag;
          sel.dispatchEvent(new Event('change'));
        }
      });
      calibOverlay.appendChild(hot);
    });
  }
  function hideChannelHotspots() {
    if (!calibOverlay) return;
    calibOverlay.querySelectorAll('.ch-hotspot').forEach((el) => el.remove());
  }

  // Active session pointer + the per-frame tick that the audio loop calls.
  state.calibrationSession = null;
  let calibTick = null;

  function startCalibration(channelTag) {
    if (!channelTag || !state.mic.live) return;
    const obj = findStripByTag(channelTag);
    state.calibrationSession = {
      channel: channelTag,
      startedAt: performance.now(),
      lastTickTs: performance.now(),
      msInTarget: 0,
      peakSeen: -Infinity,
    };
    setMeterTarget(true);
    showActiveOutline(channelTag);
    calibTick = (peak) => {
      const sess = state.calibrationSession;
      if (!sess) return;
      const now = performance.now();
      const dt = Math.max(0, now - sess.lastTickTs);
      sess.lastTickTs = now;
      if (peak > sess.peakSeen) sess.peakSeen = peak;

      const readout = document.getElementById('calibReadout');
      const status  = document.getElementById('calibStatus');
      if (!readout) return;
      const stateEl = readout.querySelector('.r-state');
      const dbEl    = readout.querySelector('.r-db');
      const dbTxt = (peak <= -90 || !isFinite(peak))
        ? '−∞'
        : (peak > 0 ? '+' : '') + peak.toFixed(1).replace(/\.0$/, '') + ' dB';
      dbEl.textContent = dbTxt;

      readout.classList.remove('quiet', 'ok', 'hot');
      if (peak < CALIB_TARGET_LOW) {
        readout.classList.add('quiet');
        stateEl.textContent = 'TOO QUIET ▴';
        sess.msInTarget = 0;
        if (status) status.textContent = `${channelTag} · raise GAIN (target −18 to −12 dBFS)`;
      } else if (peak > CALIB_TARGET_HIGH) {
        readout.classList.add('hot');
        stateEl.textContent = 'TOO HOT ▾';
        sess.msInTarget = 0;
        if (status) status.textContent = `${channelTag} · lower GAIN (target −18 to −12 dBFS)`;
      } else {
        readout.classList.add('ok');
        sess.msInTarget += dt;
        const remaining = Math.max(0, CALIB_HOLD_MS - sess.msInTarget) / 1000;
        stateEl.textContent = 'IN RANGE';
        if (status) status.textContent = remaining > 0
          ? `${channelTag} · hold for ${remaining.toFixed(1)} s …`
          : `${channelTag} · calibrated ✓`;
        if (sess.msInTarget >= CALIB_HOLD_MS) {
          // Capture the strip's current GAIN knob value so the operator has a
          // record of what was on the knob when calibration completed.
          let gainDb = 0;
          if (obj && obj.knobs && obj.knobs.gain) {
            gainDb = parseFloat(obj.knobs.gain.dataset.value) || 0;
          }
          state.calibration[channelTag] = {
            gainDb,
            peakAtCal: peak,
            completedAt: Date.now(),
          };
          showCalibratedBadge(channelTag);
          stopCalibration();
          renderActions();
        }
      }
    };
  }

  function stopCalibration() {
    state.calibrationSession = null;
    calibTick = null;
    setMeterTarget(false);
    removeActiveOutline();
    // Reset the readout pill back to neutral
    const readout = document.getElementById('calibReadout');
    if (readout) {
      readout.classList.remove('quiet', 'ok', 'hot');
      const stateEl = readout.querySelector('.r-state');
      const dbEl    = readout.querySelector('.r-db');
      if (stateEl) stateEl.textContent = '—';
      if (dbEl)    dbEl.textContent = '−∞ dB';
    }
    renderActions();
  }

  // ====================================================================
  //              PHASE 4: routing / connection management
  // ====================================================================
  // What this gives you in Routing mode:
  //   - Click any existing cable on the diagram to select it (yellow glow)
  //   - "Remove selected": removes the cable. Original cables are hidden
  //     (so Undo can restore them); custom cables are deleted from DOM.
  //   - "+ Add cable": enter pick-source state, click a yellow jack hotspot,
  //     then click the destination jack. A new SVG path is drawn.
  //   - "↻ Reroute…": on a SELECTED custom cable, pick a new destination.
  //   - "↶ Undo": pops the last action and reverses it.
  //
  // Jack registry — well-known connection points on the diagram. Each entry
  // is an absolute SVG coordinate (the main viewBox is 1800×1500).
  const JACKS = [
    // Mixer mono mic inputs (Ch 1-8) — cables from stage land here
    { id: 'mix-in-1',  label: 'Mixer Ch 1 input',  x: 635, y: 148, kind: 'mic-in' },
    { id: 'mix-in-2',  label: 'Mixer Ch 2 input',  x: 660, y: 148, kind: 'mic-in' },
    { id: 'mix-in-3',  label: 'Mixer Ch 3 input',  x: 685, y: 148, kind: 'mic-in' },
    { id: 'mix-in-4',  label: 'Mixer Ch 4 input',  x: 710, y: 148, kind: 'mic-in' },
    { id: 'mix-in-5',  label: 'Mixer Ch 5 input',  x: 735, y: 148, kind: 'mic-in' },
    { id: 'mix-in-6',  label: 'Mixer Ch 6 input',  x: 760, y: 148, kind: 'mic-in' },
    { id: 'mix-in-7',  label: 'Mixer Ch 7 input',  x: 785, y: 148, kind: 'mic-in' },
    { id: 'mix-in-8',  label: 'Mixer Ch 8 input',  x: 810, y: 148, kind: 'mic-in' },
    // Mixer stereo line inputs (Ch 9-16, L jack of each pair)
    { id: 'mix-in-9-10',   label: 'Mixer Ch 9/10 L',   x: 841, y: 137, kind: 'line-in' },
    { id: 'mix-in-11-12',  label: 'Mixer Ch 11/12 L',  x: 891, y: 137, kind: 'line-in' },
    { id: 'mix-in-13-14',  label: 'Mixer Ch 13/14 L',  x: 941, y: 137, kind: 'line-in' },
    { id: 'mix-in-15-16',  label: 'Mixer Ch 15/16 L',  x: 991, y: 137, kind: 'line-in' },
    // Mixer top-edge outputs
    { id: 'mix-out-aux1',   label: 'Mixer AUX 1 out',          x: 1043, y: 137, kind: 'output' },
    { id: 'mix-out-aux2',   label: 'Mixer AUX 2 out',          x: 1063, y: 137, kind: 'output' },
    { id: 'mix-out-aux3',   label: 'Mixer AUX 3 (STREAM) out', x: 1083, y: 137, kind: 'output' },
    { id: 'mix-out-aux4',   label: 'Mixer AUX 4 / FX SND out', x: 1103, y: 137, kind: 'output' },
    { id: 'mix-out-st-l',   label: 'Mixer ST OUT L (XLR)',     x: 1136, y: 137, kind: 'output' },
    { id: 'mix-out-st-r',   label: 'Mixer ST OUT R (XLR)',     x: 1160, y: 137, kind: 'output' },
    { id: 'mix-out-grp1',   label: 'Mixer GROUP 1 out',        x: 1192, y: 137, kind: 'output' },
    { id: 'mix-out-grp2',   label: 'Mixer GROUP 2 out',        x: 1212, y: 137, kind: 'output' },
    { id: 'mix-out-tape-l', label: 'Mixer TAPE OUT L (RCA)',   x: 1238, y: 137, kind: 'output' },
    { id: 'mix-out-tape-r', label: 'Mixer TAPE OUT R (RCA)',   x: 1252, y: 137, kind: 'output' },
    // External devices
    // FOH chain
    { id: 'foh-eq-in',         label: 'FOH 31-band EQ input',      x: 1290, y: 118, kind: 'device-input' },
    { id: 'foh-eq-out',        label: 'FOH 31-band EQ output',     x: 1528, y: 118, kind: 'device-output' },
    { id: 'crossover-in',      label: 'Crossover input',           x: 1290, y: 208, kind: 'device-input' },
    { id: 'crossover-out-lf',  label: 'Crossover LF output',       x: 1528, y: 205, kind: 'device-output' },
    { id: 'crossover-out-hf',  label: 'Crossover HF output',       x: 1528, y: 220, kind: 'device-output' },
    { id: 'lf-amp-in',         label: 'LF power amp input',        x: 1290, y: 298, kind: 'device-input' },
    { id: 'lf-amp-out-1',      label: 'LF amp out 1 (Speakon)',    x: 1528, y: 297, kind: 'device-output' },
    { id: 'lf-amp-out-2',      label: 'LF amp out 2 (Speakon)',    x: 1528, y: 315, kind: 'device-output' },
    { id: 'hf-amp-in',         label: 'HF power amp input',        x: 1290, y: 403, kind: 'device-input' },
    { id: 'hf-amp-out-1',      label: 'HF amp out 1 (Speakon)',    x: 1528, y: 401, kind: 'device-output' },
    { id: 'hf-amp-out-2',      label: 'HF amp out 2 (Speakon)',    x: 1528, y: 420, kind: 'device-output' },
    { id: 'sub-spk-in',        label: 'JBL SRX828S sub in',        x: 1718, y: 358, kind: 'device-input' },
    { id: 'top-spk-in',        label: 'JBL SRX812 top in',         x: 1716, y: 482, kind: 'device-input' },
    // Monitor chain
    { id: 'mon-amp-in-l',      label: 'Monitor amp input L',       x: 1304, y: 663, kind: 'device-input' },
    { id: 'mon-amp-in-r',      label: 'Monitor amp input R',       x: 1324, y: 663, kind: 'device-input' },
    { id: 'mon-amp-out-1',     label: 'Monitor amp out 1 (Speakon)', x: 1518, y: 663, kind: 'device-output' },
    { id: 'mon-amp-out-2',     label: 'Monitor amp out 2 (Speakon)', x: 1538, y: 663, kind: 'device-output' },
    { id: 'wedge-1-in',        label: 'Wedge 1 in (Speakon)',      x: 1715, y: 619, kind: 'device-input' },
    { id: 'wedge-2-in',        label: 'Wedge 2 in (Speakon)',      x: 1715, y: 762, kind: 'device-input' },
    // Stream destinations
    { id: 'teyun-q16',         label: 'TEYUN Q-16 (legacy)',       x: 600,  y: 1175, kind: 'device-input' },
    { id: 'audio-iface',       label: 'Audio Interface (rec.)',    x: 950,  y: 1170, kind: 'device-input' },
    // Audio link / rx
    { id: 'audio-link-in-1',   label: 'Audio link input 1',        x: 365, y: 555, kind: 'device-input' },
    { id: 'audio-link-in-2',   label: 'Audio link input 2',        x: 385, y: 555, kind: 'device-input' },
    { id: 'audio-link-in-3',   label: 'Audio link input 3',        x: 408, y: 555, kind: 'device-input' },
    { id: 'audio-link-in-4',   label: 'Audio link input 4',        x: 433, y: 555, kind: 'device-input' },
    { id: 'audio-link-in-5',   label: 'Audio link input 5 (bass)', x: 458, y: 555, kind: 'device-input' },
    { id: 'audio-link-in-6',   label: 'Audio link input 6 (keys)', x: 485, y: 555, kind: 'device-input' },
    { id: 'audio-link-snake',  label: 'Audio link snake out',      x: 580, y: 680, kind: 'device-output' },
    // Stage instrument sources
    { id: 'bass-out',          label: 'Bass combo amp DI out',     x: 178, y: 812, kind: 'device-output' },
    { id: 'keys-out',          label: 'Keyboard DI out',           x: 113, y: 951, kind: 'device-output' },
    { id: 'kick-mic',          label: 'Kick mic',                          x: 225, y: 560, kind: 'device-output' },
    { id: 'snare-mic',         label: 'Snare mic',                         x: 225, y: 575, kind: 'device-output' },
    { id: 'toms-mic',          label: 'Toms mic (shared between both toms)', x: 225, y: 590, kind: 'device-output' },
    // Wireless receiver XLR outputs — these are the "source" end of each
    // mic cable that lands on mixer Ch 1-9 inputs. Without these jacks
    // the user can't add or reroute any vocal-mic connection.
    { id: 'rx-out-V1', label: 'Wireless RX V1 out (→ Ch 1)', x: 415, y: 145, kind: 'device-output' },
    { id: 'rx-out-V2', label: 'Wireless RX V2 out (→ Ch 2)', x: 455, y: 145, kind: 'device-output' },
    { id: 'rx-out-V3', label: 'Wireless RX V3 out (→ Ch 3)', x: 495, y: 145, kind: 'device-output' },
    { id: 'rx-out-V4', label: 'Wireless RX V4 out (→ Ch 4)', x: 415, y: 285, kind: 'device-output' },
    { id: 'rx-out-V5', label: 'Wireless RX V5 out (→ Ch 5)', x: 455, y: 285, kind: 'device-output' },
    { id: 'rx-out-V6', label: 'Wireless RX V6 out (→ Ch 6)', x: 495, y: 285, kind: 'device-output' },
    { id: 'rx-out-V7', label: 'Wireless RX V7 out (→ Ch 7)', x: 415, y: 425, kind: 'device-output' },
    { id: 'rx-out-V8', label: 'Wireless RX V8 out (→ Ch 8)', x: 455, y: 425, kind: 'device-output' },
    { id: 'rx-out-V9', label: 'Wireless RX V9 out (→ Ch 9)', x: 495, y: 425, kind: 'device-output' },
  ];
  const jackById = Object.fromEntries(JACKS.map((j) => [j.id, j]));

  // SVG layer refs
  const mainSvg = document.querySelector('svg.rig');
  const jackHotspotsG = document.getElementById('jackHotspots');
  const customCablesG = document.getElementById('customCables');
  const previewCableG = document.getElementById('previewCable');

  // Mixer chassis bounds in absolute SVG coords. Cables should not slice
  // through this rectangle on the way between their endpoints.
  const MIXER_BOX = { l: 620, r: 1260, t: 70, b: 610 };

  // True if the straight Bezier between (x1,y1) and (x2,y2) would visibly
  // cross the mixer chassis. Cheap heuristic: sample 9 points along a
  // straight-line approximation and check if any sit inside the box.
  function pathCrossesMixer(x1, y1, x2, y2) {
    const box = MIXER_BOX;
    const inside = (x, y) => x > box.l && x < box.r && y > box.t && y < box.b;
    if (inside(x1, y1) || inside(x2, y2)) {
      // Endpoint on a mixer top-edge jack counts as on-edge, not crossing.
      // We only flag a crossing if MID-POINTS are inside.
    }
    for (let i = 1; i < 10; i++) {
      const t = i / 10;
      const x = x1 + (x2 - x1) * t;
      const y = y1 + (y2 - y1) * t;
      if (inside(x, y)) return true;
    }
    return false;
  }

  // Build an SVG path between two points that avoids cutting through the
  // mixer chassis. Three cases:
  //   1. The straight Bezier is clear → single cubic, biased along the
  //      dominant axis.
  //   2. Path would cross AND both endpoints are above the chassis bottom
  //      → short "up and over" route (two cubics). Common case for any
  //      cable between rx racks / stage / mixer top-edge jacks.
  //   3. One endpoint is below the chassis (output going to amp / soundcard
  //      below the mixer) → "around the side wall" route (three cubics).
  function buildCablePath(x1, y1, x2, y2) {
    const M = MIXER_BOX;
    const dx = x2 - x1, dy = y2 - y1;

    if (!pathCrossesMixer(x1, y1, x2, y2)) {
      const horiz = Math.abs(dx) > Math.abs(dy);
      const cx1 = horiz ? x1 + dx * 0.5 : x1;
      const cy1 = horiz ? y1               : y1 + dy * 0.5;
      const cx2 = horiz ? x2 - dx * 0.5 : x2;
      const cy2 = horiz ? y2               : y2 - dy * 0.5;
      return `M ${x1} ${y1} C ${cx1.toFixed(1)} ${cy1.toFixed(1)} ${cx2.toFixed(1)} ${cy2.toFixed(1)} ${x2} ${y2}`;
    }

    const ARC_TOP = 18;  // y above chassis top — the "highway" cables ride on
    const bothNotBelow = y1 < M.b && y2 < M.b;

    if (bothNotBelow) {
      // Up over the top, then drop down to destination. No side-wall detour.
      const midY = (y2 + ARC_TOP) / 2;
      return (
        `M ${x1} ${y1} ` +
        `C ${x1} ${ARC_TOP} ${x2} ${ARC_TOP} ${x2} ${midY.toFixed(1)} ` +
        `C ${x2} ${y2} ${x2} ${y2} ${x2} ${y2}`
      );
    }

    // One endpoint is below the chassis bottom. Route: from the LOW endpoint
    // sideways to the side wall, up the OUTSIDE of that wall to ARC_TOP,
    // across to above the HIGH endpoint's x, then down. Side wall is chosen
    // based on whichever endpoint is below — NOT just the destination — so a
    // cable from a bottom-left soundcard doesn't loop all the way to the
    // right amp rack just because the destination happens to be central.
    const lowY  = Math.max(y1, y2);
    const lowX  = (lowY === y1) ? x1 : x2;
    const highX = (lowY === y1) ? x2 : x1;
    const highY = Math.min(y1, y2);
    // Side wall closest to the LOW endpoint
    const sideX = lowX < (M.l + M.r) / 2 ? M.l - 60 : M.r + 60;
    // Build 4 cubics through the waypoint chain. If the user's source was
    // the HIGH point, reverse so the path still starts at (x1, y1).
    const wps = [
      [lowX, lowY],
      [sideX, lowY],
      [sideX, ARC_TOP],
      [highX, ARC_TOP],
      [highX, highY],
    ];
    if (lowY !== y1) wps.reverse();
    let d = `M ${wps[0][0]} ${wps[0][1]}`;
    for (let i = 1; i < wps.length; i++) {
      const [px, py] = wps[i - 1];
      const [x,  y ] = wps[i];
      const dxs = x - px, dys = y - py;
      const horiz = Math.abs(dxs) > Math.abs(dys);
      const cx1 = horiz ? px + dxs * 0.5 : px;
      const cy1 = horiz ? py              : py + dys * 0.5;
      const cx2 = horiz ? x  - dxs * 0.5 : x;
      const cy2 = horiz ? y               : y  - dys * 0.5;
      d += ` C ${cx1.toFixed(1)} ${cy1.toFixed(1)} ${cx2.toFixed(1)} ${cy2.toFixed(1)} ${x} ${y}`;
    }
    return d;
  }

  function showJackHotspots() {
    if (!jackHotspotsG) return;
    jackHotspotsG.innerHTML = '';
    for (const j of JACKS) {
      const hot = svgEl('circle', {
        class: 'jack-hotspot',
        cx: j.x, cy: j.y, r: 7,
        'data-jack-id': j.id,
      });
      const title = svgEl('title');
      title.textContent = j.label;
      hot.appendChild(title);
      hot.addEventListener('click', (e) => onJackClick(j.id, e));
      jackHotspotsG.appendChild(hot);
    }
  }
  function hideJackHotspots() {
    if (jackHotspotsG) jackHotspotsG.innerHTML = '';
  }

  function selectCablePath(pathEl) {
    if (state.routing.selectedPathEl) {
      state.routing.selectedPathEl.classList.remove('cable-selected');
    }
    state.routing.selectedPathEl = pathEl;
    if (pathEl) pathEl.classList.add('cable-selected');
  }

  // Attach a click handler that selects the cable when in routing mode.
  // Idempotent: marks elements with _routingBound so we don't double-bind.
  function bindCableSelectability() {
    document.querySelectorAll('path[class*="cable-"]').forEach((p) => {
      if (p._routingBound) return;
      p._routingBound = true;
      p.addEventListener('click', (e) => {
        if (state.mode !== 'routing') return;
        if (state.routing.addStep || state.routing.rerouteStep) return;
        e.stopPropagation();
        selectCablePath(p);
        renderActions();
      });
    });
  }

  // Background click in routing mode cancels pending workflows / deselects.
  let bgClickBound = false;
  function bindBackgroundDeselect() {
    if (bgClickBound) return;
    bgClickBound = true;
    mainSvg.addEventListener('click', (e) => {
      if (state.mode !== 'routing') return;
      // Cable / hotspot clicks are handled by their own listeners (which
      // stopPropagation). If we got here, the click was on the background.
      if (state.routing.addStep) {
        cancelAdd();
      } else if (state.routing.rerouteStep) {
        cancelReroute();
      } else if (state.routing.selectedPathEl) {
        selectCablePath(null);
        renderActions();
      }
    });
  }

  function enterRoutingMode() {
    showJackHotspots();
    bindCableSelectability();
    bindBackgroundDeselect();
  }
  function exitRoutingMode() {
    if (state.routing.addStep) cancelAdd();
    if (state.routing.rerouteStep) cancelReroute();
    selectCablePath(null);
    hideJackHotspots();
  }

  // ---- Add cable workflow ----
  function startAddCable() {
    selectCablePath(null);
    state.routing.addStep = 'pickSource';
    state.routing.pendingSource = null;
    renderActions();
  }
  function cancelAdd() {
    state.routing.addStep = null;
    if (state.routing.pendingSource) {
      const hot = jackHotspotsG.querySelector(`[data-jack-id="${state.routing.pendingSource.id}"]`);
      if (hot) hot.classList.remove('pending-source');
    }
    state.routing.pendingSource = null;
    hidePreviewCable();
    renderActions();
  }

  function onJackClick(jackId, ev) {
    if (state.mode !== 'routing') return;
    ev.stopPropagation();
    const j = jackById[jackId];
    if (!j) return;

    if (state.routing.addStep === 'pickSource') {
      state.routing.pendingSource = j;
      state.routing.addStep = 'pickDest';
      const hot = jackHotspotsG.querySelector(`[data-jack-id="${j.id}"]`);
      if (hot) hot.classList.add('pending-source');
      showPreviewCable(j);
      renderActions();
      return;
    }
    if (state.routing.addStep === 'pickDest') {
      const src = state.routing.pendingSource;
      if (j.id === src.id) { cancelAdd(); return; }
      addCustomCable(src, j);
      cancelAdd();
      return;
    }
    if (state.routing.rerouteStep) {
      finishReroute(j);
      return;
    }
  }

  function addCustomCable(source, dest, fromUndo) {
    const id = 'custom-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
    const path = svgEl('path', {
      class: 'cable-custom',
      'data-cable-id': id,
      d: buildCablePath(source.x, source.y, dest.x, dest.y),
      'marker-end': 'url(#arrow)',
      fill: 'none',
    });
    customCablesG.appendChild(path);
    path._routingBound = true;
    path.addEventListener('click', (e) => {
      if (state.mode !== 'routing') return;
      if (state.routing.addStep || state.routing.rerouteStep) return;
      e.stopPropagation();
      selectCablePath(path);
      renderActions();
    });
    const entry = { id, from: source.id, to: dest.id, pathEl: path };
    state.routing.customCables.push(entry);
    if (!fromUndo) {
      state.actionStack.push({ type: 'add', cable: entry });
    }
    renderActions();
  }

  // ---- Remove ----
  function removeSelectedCable() {
    const p = state.routing.selectedPathEl;
    if (!p) return;
    const idx = state.routing.customCables.findIndex((c) => c.pathEl === p);
    if (idx >= 0) {
      const c = state.routing.customCables[idx];
      state.routing.customCables.splice(idx, 1);
      p.parentNode && p.parentNode.removeChild(p);
      state.actionStack.push({ type: 'remove-custom', cable: c });
    } else {
      // Original cable — hide instead of delete so undo can restore.
      p.style.display = 'none';
      state.actionStack.push({ type: 'remove-original', pathEl: p });
    }
    state.routing.selectedPathEl = null;
    renderActions();
  }

  // ---- Reroute (custom cables only) ----
  function startReroute() {
    if (!state.routing.selectedPathEl) return;
    const entry = state.routing.customCables.find((c) => c.pathEl === state.routing.selectedPathEl);
    if (!entry) return;
    state.routing.rerouteStep = true;
    state.routing.pendingSource = jackById[entry.from];
    // Mark source hotspot
    const hot = jackHotspotsG.querySelector(`[data-jack-id="${entry.from}"]`);
    if (hot) hot.classList.add('pending-source');
    showPreviewCable(jackById[entry.from]);
    renderActions();
  }
  function cancelReroute() {
    state.routing.rerouteStep = false;
    if (state.routing.pendingSource) {
      const hot = jackHotspotsG.querySelector(`[data-jack-id="${state.routing.pendingSource.id}"]`);
      if (hot) hot.classList.remove('pending-source');
    }
    state.routing.pendingSource = null;
    hidePreviewCable();
    renderActions();
  }
  function finishReroute(newDest) {
    const entry = state.routing.customCables.find((c) => c.pathEl === state.routing.selectedPathEl);
    if (!entry) { cancelReroute(); return; }
    const oldTo = entry.to;
    entry.to = newDest.id;
    const src = jackById[entry.from];
    entry.pathEl.setAttribute('d', buildCablePath(src.x, src.y, newDest.x, newDest.y));
    state.actionStack.push({ type: 'reroute', cableId: entry.id, oldTo, newTo: newDest.id });
    cancelReroute();
  }

  // ---- Undo ----
  function undoLastAction() {
    const a = state.actionStack.pop();
    if (!a) return;
    if (a.type === 'add') {
      const idx = state.routing.customCables.findIndex((c) => c.id === a.cable.id);
      if (idx >= 0) {
        const c = state.routing.customCables[idx];
        c.pathEl.parentNode && c.pathEl.parentNode.removeChild(c.pathEl);
        state.routing.customCables.splice(idx, 1);
      }
    } else if (a.type === 'remove-custom') {
      customCablesG.appendChild(a.cable.pathEl);
      state.routing.customCables.push(a.cable);
    } else if (a.type === 'remove-original') {
      a.pathEl.style.display = '';
    } else if (a.type === 'reroute') {
      const entry = state.routing.customCables.find((c) => c.id === a.cableId);
      if (entry) {
        entry.to = a.oldTo;
        const src = jackById[entry.from];
        const dst = jackById[entry.to];
        if (src && dst) entry.pathEl.setAttribute('d', buildCablePath(src.x, src.y, dst.x, dst.y));
      }
    }
    renderActions();
  }

  // ---- Preview cable (follows cursor during pickDest) ----
  let previewPath = null;
  function showPreviewCable(source) {
    if (!previewCableG) return;
    previewCableG.innerHTML = '';
    previewPath = svgEl('path', {
      class: 'cable-preview',
      d: `M ${source.x} ${source.y} L ${source.x} ${source.y}`,
      'pointer-events': 'none',
    });
    previewCableG.appendChild(previewPath);
    document.addEventListener('mousemove', onPreviewMouseMove);
  }
  function hidePreviewCable() {
    if (previewCableG) previewCableG.innerHTML = '';
    previewPath = null;
    document.removeEventListener('mousemove', onPreviewMouseMove);
  }
  function onPreviewMouseMove(e) {
    if (!previewPath || !state.routing.pendingSource) return;
    const ctm = mainSvg.getScreenCTM();
    if (!ctm) return;
    const pt = mainSvg.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    const svgPt = pt.matrixTransform(ctm.inverse());
    const s = state.routing.pendingSource;
    previewPath.setAttribute('d', buildCablePath(s.x, s.y, svgPt.x, svgPt.y));
  }

  // ESC key cancels any pending workflow
  document.addEventListener('keydown', (e) => {
    if (state.mode !== 'routing') return;
    if (e.key !== 'Escape') return;
    if (state.routing.addStep) cancelAdd();
    else if (state.routing.rerouteStep) cancelReroute();
    else if (state.routing.selectedPathEl) { selectCablePath(null); renderActions(); }
  });

  // ====================================================================
  //              PHASE 5: save / load configurations
  // ====================================================================
  const STATE_VERSION = 1;
  const CONFIGS_KEY = 'mq16fx.configs';

  function readConfigs() {
    try { return JSON.parse(localStorage.getItem(CONFIGS_KEY) || '{}'); }
    catch (_) { return {}; }
  }
  function writeConfigs(o) {
    try { localStorage.setItem(CONFIGS_KEY, JSON.stringify(o)); } catch (_) {}
  }

  // Snapshot every interactive UI element so the same config can be restored later.
  function captureState() {
    return {
      version: STATE_VERSION,
      timestamp: new Date().toISOString(),
      strips: stripObjs.map(({ s, knobs, fader }) => ({
        tag: s.tag,
        knobs: Object.fromEntries(KNOB_ROWS.map((r) => [r.name, parseFloat(knobs[r.name].dataset.value)])),
        fader: fader ? parseFloat(fader.dataset.value) : -60,
      })),
      rightCol: Object.fromEntries(Object.entries(rightColumnKnobs).map(([k, v]) => [k, parseFloat(v.dataset.value)])),
      masters: Object.fromEntries(Object.entries(masterFaderObjs).map(([k, v]) => [k, parseFloat(v.dataset.value)])),
      switches: Array.from(document.querySelectorAll('#chInputSwitches .ch-sw')).map((sw) => ({
        type: sw.dataset.type, ch: sw.dataset.ch, on: sw.dataset.on === 'true',
      })),
      mutes: Array.from(document.querySelectorAll('g[data-strip] .strip-mute')).map((m) => ({
        ch: m.parentElement.getAttribute('data-strip'), muted: m.dataset.muted === 'true',
      })),
      calibration: { ...state.calibration },
      customCables: state.routing.customCables.map((c) => ({ from: c.from, to: c.to })),
      hiddenOriginalsD: Array.from(document.querySelectorAll('svg.rig path[class*="cable-"]'))
        .filter((p) => p.style.display === 'none' && !p.classList.contains('cable-custom'))
        .map((p) => p.getAttribute('d')),
    };
  }

  function applyState(s) {
    if (!s) return;
    // Strip knobs + faders
    (s.strips || []).forEach((sd) => {
      const obj = stripObjs.find((o) => o.s.tag === sd.tag);
      if (!obj) return;
      Object.entries(sd.knobs || {}).forEach(([k, v]) => { if (obj.knobs[k]) obj.knobs[k]._render(v); });
      if (obj.fader && typeof sd.fader === 'number') obj.fader._render(sd.fader);
    });
    // Right column + master faders
    Object.entries(s.rightCol || {}).forEach(([k, v]) => { if (rightColumnKnobs[k]) rightColumnKnobs[k]._render(v); });
    Object.entries(s.masters || {}).forEach(([k, v]) => { if (masterFaderObjs[k]) masterFaderObjs[k]._render(v); });
    // HI-Z / MIC-LINE switches — set state directly + sync visuals via re-click if needed
    (s.switches || []).forEach((sw) => {
      const el = document.querySelector(`#chInputSwitches .ch-sw[data-type="${sw.type}"][data-ch="${sw.ch}"]`);
      if (!el) return;
      if ((el.dataset.on === 'true') !== sw.on) el.click();
    });
    // MUTE buttons
    (s.mutes || []).forEach((m) => {
      const el = document.querySelector(`g[data-strip="${m.ch}"] .strip-mute`);
      if (!el) return;
      if ((el.dataset.muted === 'true') !== m.muted) el.click();
    });
    // Calibration ✓ badges
    if (calibOverlay) calibOverlay.querySelectorAll('.strip-calibrated').forEach((el) => el.remove());
    state.calibration = s.calibration ? { ...s.calibration } : {};
    Object.keys(state.calibration).forEach((tag) => showCalibratedBadge(tag));
    // Custom cables: clear and rebuild
    state.routing.customCables.forEach((c) => { if (c.pathEl && c.pathEl.parentNode) c.pathEl.parentNode.removeChild(c.pathEl); });
    state.routing.customCables = [];
    (s.customCables || []).forEach((c) => {
      const src = jackById[c.from], dst = jackById[c.to];
      if (src && dst) addCustomCable(src, dst, true);
    });
    // Hidden originals — re-show all, then re-hide those that match a saved d=
    document.querySelectorAll('svg.rig path[class*="cable-"]').forEach((p) => {
      if (!p.classList.contains('cable-custom')) p.style.display = '';
    });
    const hideSet = new Set(s.hiddenOriginalsD || []);
    document.querySelectorAll('svg.rig path[class*="cable-"]').forEach((p) => {
      if (!p.classList.contains('cable-custom') && hideSet.has(p.getAttribute('d'))) p.style.display = 'none';
    });
    state.actionStack = [];
    renderActions();
  }

  // "Default" preset: hide every original cable and clear knobs / faders /
  // switches / mutes / calibration. Devices stay, slots become wirable.
  function loadDefaultPreset() {
    // Reset all controls
    const resetBtn = document.getElementById('svgResetAll');
    if (resetBtn) resetBtn.dispatchEvent(new Event('click'));
    // Hide every original cable
    document.querySelectorAll('svg.rig path[class*="cable-"]').forEach((p) => {
      if (!p.classList.contains('cable-custom')) p.style.display = 'none';
    });
    // Drop any custom cables
    state.routing.customCables.forEach((c) => { if (c.pathEl && c.pathEl.parentNode) c.pathEl.parentNode.removeChild(c.pathEl); });
    state.routing.customCables = [];
    state.actionStack = [];
    // Auto-switch to Routing mode so the user can immediately start wiring
    setMode('routing');
    setBanner('Default preset loaded — every device is on the diagram with no cables. Switch to Routing mode to wire each jack manually.', 'warn');
  }

  function refreshConfigSelect() {
    const sel = document.getElementById('configSelect');
    if (!sel) return;
    const configs = readConfigs();
    const current = sel.value;
    sel.innerHTML = '<option value="">— current —</option>';
    Object.keys(configs).sort().forEach((name) => {
      const opt = new Option(name, name);
      sel.appendChild(opt);
    });
    if (current && configs[current]) sel.value = current;
  }

  // Wire the configs toolbar
  const configSel = document.getElementById('configSelect');
  if (configSel) {
    configSel.addEventListener('change', () => {
      if (!configSel.value) return;
      const configs = readConfigs();
      const cfg = configs[configSel.value];
      if (cfg) {
        applyState(cfg);
        setBanner(`Loaded config "${configSel.value}".`, 'warn');
      }
    });
  }
  const saveBtn = document.getElementById('configSave');
  if (saveBtn) saveBtn.addEventListener('click', () => {
    const name = prompt('Save configuration as:', (configSel && configSel.value) || 'My config');
    if (!name) return;
    const configs = readConfigs();
    configs[name] = captureState();
    writeConfigs(configs);
    refreshConfigSelect();
    if (configSel) configSel.value = name;
    setBanner(`Saved config "${name}".`, 'warn');
  });
  const defaultBtn = document.getElementById('configDefault');
  if (defaultBtn) defaultBtn.addEventListener('click', loadDefaultPreset);
  const exportBtn = document.getElementById('configExport');
  if (exportBtn) exportBtn.addEventListener('click', () => {
    const data = JSON.stringify(captureState(), null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `mq16fx-config-${new Date().toISOString().slice(0,16).replace(/[:T]/g,'-')}.json`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 500);
  });
  const importBtn = document.getElementById('configImport');
  const importFile = document.getElementById('configImportFile');
  if (importBtn && importFile) {
    importBtn.addEventListener('click', () => importFile.click());
    importFile.addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const cfg = JSON.parse(reader.result);
          applyState(cfg);
          setBanner(`Imported config from ${f.name}.`, 'warn');
        } catch (err) {
          setBanner(`Import failed: ${err.message}`, 'error');
        }
      };
      reader.readAsText(f);
      importFile.value = '';
    });
  }
  refreshConfigSelect();

  if (micBtn) {
    const lbl = micBtn.querySelector('.mic-label');
    const lvl = micBtn.querySelector('.mic-level');

    micBtn.addEventListener('click', async () => {
      // Toggle off
      if (micSession) {
        micSession.stop();
        micSession = null;
        state.mic.live = false;
        state.mic.level = -Infinity;
        micBtn.classList.remove('live');
        micBtn.classList.remove('error');
        lbl.textContent = 'Connect mic';
        lvl.hidden = true;
        setBanner('');
        if (state.mode === 'calibration') renderActions();
        return;
      }
      // Toggle on
      try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          throw new Error('Browser has no getUserMedia API');
        }
        micSession = await startMic();
        state.mic.live = true;
        state.mic.err = null;
        micBtn.classList.add('live');
        micBtn.classList.remove('error');
        lbl.textContent = 'Mic live';
        lvl.hidden = false;
        setBanner('');
        if (state.mode === 'calibration') renderActions();
      } catch (err) {
        state.mic.live = false;
        state.mic.err = err && err.message ? err.message : String(err);
        micBtn.classList.add('error');
        lbl.textContent = 'Mic error';
        const isFile = location.protocol === 'file:';
        setBanner(
          isFile
            ? 'Mic blocked because the page is served over <code>file://</code>. ' +
              'Run <code>python3 -m http.server 8000</code> in <code>' +
              '/Users/ellis/Documents/GitHub/church-audio-config</code>, then open ' +
              '<code>http://localhost:8000/signal-chain.html</code> and click Connect mic again.'
            : `Mic error: ${state.mic.err}. Check the browser's site-permission dropdown for microphone access.`,
          'error'
        );
      }
    });
  }

  // Initial render
  renderActions();
  setMode('performance');

  // ---------- Channel configuration ----------
  // x = mixer-local horizontal centre of the strip (lines up with the scribble strip above).
  // EQ targets reflect a typical warm-and-intelligible preset for that source.
  const STRIPS = [
    { tag: 'V1',     x: 24,  gain: 38, hi: 3, midF: 3000, midG: 2, lo: -3, aux1: 8.5, aux2: 4, aux3: 8.5, fader:  0 },
    { tag: 'V2',     x: 49,  gain: 36, hi: 2, midF: 3000, midG: 2, lo: -3, aux1: 7,   aux2: 4, aux3: 7,   fader:  0 },
    { tag: 'V3',     x: 74,  gain: 36, hi: 2, midF: 3000, midG: 2, lo: -3, aux1: 7,   aux2: 4, aux3: 7,   fader:  0 },
    { tag: 'V4',     x: 99,  gain: 35, hi: 2, midF: 3200, midG: 2, lo: -3, aux1: 7,   aux2: 4, aux3: 7,   fader: -1 },
    { tag: 'V5',     x: 124, gain: 35, hi: 2, midF: 3200, midG: 2, lo: -3, aux1: 7,   aux2: 4, aux3: 7,   fader: -1 },
    { tag: 'V6',     x: 149, gain: 35, hi: 2, midF: 3200, midG: 2, lo: -3, aux1: 6,   aux2: 4, aux3: 6.5, fader: -2 },
    { tag: 'V7',     x: 174, gain: 35, hi: 2, midF: 3200, midG: 2, lo: -3, aux1: 6,   aux2: 4, aux3: 6.5, fader: -2 },
    { tag: 'V8',     x: 199, gain: 34, hi: 2, midF: 3200, midG: 2, lo: -3, aux1: 5,   aux2: 4, aux3: 6,   fader: -3 },
    { tag: 'KIK/V9', x: 235, gain: 30, hi: 1, midF: 500,  midG: -4, lo: 4,  aux1: 3,  aux2: 8, aux3: 3,   fader: -2 },
    { tag: 'DRUM',   x: 285, gain: 32, hi: 3, midF: 1500, midG: -2, lo: -6, aux1: 4,  aux2: 8, aux3: 4,   fader: -3 },
    { tag: 'KEYS',   x: 335, gain: 28, hi: 1, midF: 1500, midG: 0,  lo: 0,  aux1: 5,  aux2: 6, aux3: 5,   fader: -2 },
    { tag: 'BASS',   x: 385, gain: 30, hi: 0, midF: 800,  midG: 3,  lo: 2,  aux1: 4,  aux2: 7, aux3: 4,   fader: -2 },
  ];

  // ---------- Knob primitive ----------
  // Knobs sweep -135° (min) → +135° (max), total arc 270°.
  const SWEEP_DEG = 270;
  const SWEEP_MIN = -135;

  function angleForFraction(f) { return SWEEP_MIN + SWEEP_DEG * f; }

  function fmt(value, spec) {
    const { type, unit } = spec;
    if (type === 'freq') {
      if (value >= 1000) return (value / 1000).toFixed(value >= 10000 ? 0 : 2).replace(/\.?0+$/, '') + ' kHz';
      return Math.round(value) + ' Hz';
    }
    if (type === 'gain-bipolar') {
      const v = value;
      if (Math.abs(v) < 0.05) return '0 dB';
      return (v > 0 ? '+' : '') + v.toFixed(1).replace(/\.0$/, '') + ' dB';
    }
    if (type === 'pan') {
      if (Math.abs(value) < 0.03) return 'C';
      const pct = Math.round(Math.abs(value) * 100);
      return (value < 0 ? 'L' : 'R') + pct;
    }
    if (type === 'fader-db') {
      if (value <= -60) return '−∞';
      return (value > 0 ? '+' : '') + value.toFixed(1).replace(/\.0$/, '') + ' dB';
    }
    if (type === 'aux') {
      return value.toFixed(1).replace(/\.0$/, '');
    }
    if (type === 'preset') {
      return Math.round(value).toString().padStart(2, '0');
    }
    return value.toFixed(1) + (unit || '');
  }

  // Knob spec table — defines min/max/curve/format per knob name
  const KNOB_SPECS = {
    gain:  { min: 0,   max: 60,   def: 0, type: 'gain-bipolar', unit: 'dB', style: 'gain',  label: 'GAIN' },
    hi:    { min: -15, max: 15,   def: 0, type: 'gain-bipolar', unit: 'dB', style: 'hi',    label: 'HI 12k', bipolar: true },
    midF:  { min: 100, max: 8000, def: 1000, type: 'freq',      unit: 'Hz', style: 'midf',  label: 'MID Hz', log: true },
    midG:  { min: -15, max: 15,   def: 0, type: 'gain-bipolar', unit: 'dB', style: 'midg',  label: 'MID dB', bipolar: true },
    lo:    { min: -15, max: 15,   def: 0, type: 'gain-bipolar', unit: 'dB', style: 'lo',    label: 'LO 80', bipolar: true },
    aux1:  { min: 0,   max: 10,   def: 0, type: 'aux',          unit: '',   style: 'aux1',  label: 'AUX 1' },
    aux2:  { min: 0,   max: 10,   def: 0, type: 'aux',          unit: '',   style: 'aux2',  label: 'AUX 2' },
    aux3:  { min: 0,   max: 10,   def: 0, type: 'aux',          unit: '',   style: 'aux3',  label: 'STREAM' },
    fx:    { min: 0,   max: 10,   def: 0, type: 'aux',          unit: '',   style: 'fx',    label: 'FX' },
    pan:   { min: -1,  max: 1,    def: 0, type: 'pan',          unit: '',   style: 'pan',   label: 'PAN', bipolar: true },
    // Right master column
    preset: { min: 1, max: 99, def: 1, type: 'preset', unit: '', style: 'aux3', label: 'PRESET' },
    fxIn:   { min: 0, max: 10, def: 0, type: 'aux',    unit: '', style: 'fx',   label: 'FX IN' },
    fxOut:  { min: 0, max: 10, def: 0, type: 'aux',    unit: '', style: 'fx',   label: 'FX OUT' },
    aux1m:  { min: 0, max: 10, def: 0, type: 'aux',    unit: '', style: 'aux1', label: 'AUX 1' },
    aux2m:  { min: 0, max: 10, def: 0, type: 'aux',    unit: '', style: 'aux2', label: 'AUX 2' },
    aux3m:  { min: 0, max: 10, def: 0, type: 'aux',    unit: '', style: 'aux3', label: 'STREAM' },
    aux4m:  { min: 0, max: 10, def: 0, type: 'aux',    unit: '', style: 'fx',   label: 'FX SND' },
  };

  function valueToFraction(value, spec) {
    if (spec.log) {
      const a = Math.log(spec.min), b = Math.log(spec.max);
      return (Math.log(value) - a) / (b - a);
    }
    return (value - spec.min) / (spec.max - spec.min);
  }
  function fractionToValue(frac, spec) {
    frac = Math.max(0, Math.min(1, frac));
    if (spec.log) {
      const a = Math.log(spec.min), b = Math.log(spec.max);
      return Math.exp(a + (b - a) * frac);
    }
    return spec.min + (spec.max - spec.min) * frac;
  }

  // Knob layout: vertical position (within the #mixerStrips group) and the label shown
  // in the left margin once. The names match keys in KNOB_SPECS and STRIPS.
  const KNOB_ROWS = [
    { name: 'gain', y: 10,  label: 'GAIN'   },
    { name: 'hi',   y: 30,  label: 'HI 12k' },
    { name: 'midF', y: 50,  label: 'MID Hz' },
    { name: 'midG', y: 70,  label: 'MID dB' },
    { name: 'lo',   y: 90,  label: 'LO 80'  },
    { name: 'aux1', y: 110, label: 'AUX 1'  },
    { name: 'aux2', y: 130, label: 'AUX 2'  },
    { name: 'aux3', y: 150, label: 'STREAM' },
  ];

  // SVG arc path between two angles (deg) at radius r, centred at 0,0.
  function arcPath(startDeg, endDeg, r) {
    const startRad = (startDeg - 90) * Math.PI / 180;
    const endRad   = (endDeg   - 90) * Math.PI / 180;
    const x1 = Math.cos(startRad) * r, y1 = Math.sin(startRad) * r;
    const x2 = Math.cos(endRad)   * r, y2 = Math.sin(endRad)   * r;
    const large = Math.abs(endDeg - startDeg) > 180 ? 1 : 0;
    const sweep = endDeg >= startDeg ? 1 : 0;
    return `${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${large} ${sweep} ${x2.toFixed(2)} ${y2.toFixed(2)}`;
  }

  function makeKnob(name, cx, cy, target, currentValue, inlineLabel) {
    const spec = KNOB_SPECS[name];
    const g = svgEl('g', {
      class: 'svg-knob',
      'data-style': spec.style === 'midf' ? 'midF' : (spec.style === 'midg' ? 'midG' : spec.style),
      transform: `translate(${cx}, ${cy})`,
    });
    g.dataset.target = target;
    g.dataset.value = currentValue;

    g.appendChild(svgEl('path', { class: 'knob-track', d: 'M ' + arcPath(-135, 135, 7) }));
    const arc = svgEl('path', { class: 'knob-arc', d: '' });
    g.appendChild(arc);
    g.appendChild(svgEl('circle', { class: 'knob-body', r: 5.5, cx: 0, cy: 0 }));
    const ind = svgEl('line', { class: 'knob-indicator', x1: 0, y1: -1.8, x2: 0, y2: -5 });
    g.appendChild(ind);

    const targetFrac = valueToFraction(target, spec);
    const targetAngle = angleForFraction(targetFrac);
    const trad = (targetAngle - 90) * Math.PI / 180;
    g.appendChild(svgEl('circle', {
      class: 'knob-suggest',
      cx: (Math.cos(trad) * 9).toFixed(2),
      cy: (Math.sin(trad) * 9).toFixed(2),
      r: 0.85,
    }));

    const valText = svgEl('text', { class: 'knob-value', x: 0, y: 12 });
    g.appendChild(valText);

    if (inlineLabel) {
      const lbl = svgEl('text', { class: 'knob-inline-label', x: 0, y: 19 });
      lbl.textContent = inlineLabel;
      g.appendChild(lbl);
    }

    function render(v) {
      g.dataset.value = v;
      const frac = valueToFraction(v, spec);
      const angle = angleForFraction(frac);
      ind.setAttribute('transform', `rotate(${angle})`);
      valText.textContent = fmt(v, spec);
      const startAngle = spec.bipolar ? 0 : -135;
      arc.setAttribute('d', 'M ' + arcPath(Math.min(startAngle, angle), Math.max(startAngle, angle), 7));
      const tol = spec.log ? 0.04 : (spec.max - spec.min) * 0.025;
      const matched = spec.log
        ? Math.abs(Math.log(v) - Math.log(target)) < tol
        : Math.abs(v - target) < tol;
      g.classList.toggle('matched', matched);
    }
    render(currentValue);

    // Pointer drag: vertical move = value change. Shift = fine.
    let dragging = false, lastY = 0, accumFrac = 0;
    g.addEventListener('pointerdown', (e) => {
      dragging = true;
      lastY = e.clientY;
      accumFrac = valueToFraction(parseFloat(g.dataset.value), spec);
      g.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    g.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dy = lastY - e.clientY;
      lastY = e.clientY;
      const speed = e.shiftKey ? 750 : 150;
      accumFrac = Math.max(0, Math.min(1, accumFrac + dy / speed));
      render(fractionToValue(accumFrac, spec));
    });
    function endDrag(e) {
      if (!dragging) return;
      dragging = false;
      try { g.releasePointerCapture(e.pointerId); } catch(_) {}
    }
    g.addEventListener('pointerup', endDrag);
    g.addEventListener('pointercancel', endDrag);
    g.addEventListener('dblclick', () => render(target));
    g._render = render;
    g._spec = spec;
    g._target = target;
    return g;
  }

  // ---------- Mount knobs into the in-diagram mixer ----------
  const mountRoot = document.getElementById('mixerStrips');
  if (!mountRoot) return;

  // Row labels in the left margin (once for the whole rack)
  KNOB_ROWS.forEach((row) => {
    const lbl = svgEl('text', { x: 12, y: row.y + 1.7, 'text-anchor': 'end' });
    lbl.setAttribute('style', 'font:700 5.5px ui-monospace,monospace;fill:#94a3b8');
    lbl.textContent = row.label;
    mountRoot.appendChild(lbl);
  });

  const stripObjs = [];
  STRIPS.forEach((s) => {
    const sg = svgEl('g', { 'data-strip': s.tag });
    const knobs = {};
    KNOB_ROWS.forEach((row) => {
      const k = makeKnob(row.name, s.x, row.y, s[row.name], KNOB_SPECS[row.name].def);
      sg.appendChild(k);
      knobs[row.name] = k;
    });

    // PEAK LED (decorative — lights red when channel gain risks clipping; here a static off-state dot)
    const peakLed = svgEl('circle', {
      class: 'strip-peak',
      cx: s.x, cy: 168, r: 1.5,
      fill: '#3f0a0a', stroke: '#52525b', 'stroke-width': 0.3,
    });
    sg.appendChild(peakLed);

    // MUTE button (interactive — click to toggle red)
    const muteG = svgEl('g', { class: 'strip-mute', transform: `translate(${s.x - 7}, 173)` });
    muteG.style.cursor = 'pointer';
    const muteRect = svgEl('rect', { x: 0, y: 0, width: 14, height: 7, rx: 1.2, fill: '#1f2937', stroke: '#475569', 'stroke-width': 0.4 });
    const muteText = svgEl('text', { x: 7, y: 5.2, 'text-anchor': 'middle' });
    muteText.setAttribute('style', 'font:700 4.5px ui-monospace,monospace;fill:#cbd5e1;pointer-events:none');
    muteText.textContent = 'MUTE';
    muteG.appendChild(muteRect);
    muteG.appendChild(muteText);
    muteG.dataset.muted = 'false';
    muteG.addEventListener('click', () => {
      const willMute = muteG.dataset.muted !== 'true';
      muteG.dataset.muted = willMute ? 'true' : 'false';
      muteRect.setAttribute('fill', willMute ? '#7f1d1d' : '#1f2937');
      muteRect.setAttribute('stroke', willMute ? '#ef4444' : '#475569');
      muteText.setAttribute('style', `font:700 4.5px ui-monospace,monospace;fill:${willMute ? '#fee2e2' : '#cbd5e1'};pointer-events:none`);
    });
    sg.appendChild(muteG);

    // Per-channel vertical fader (below the knobs, mirroring the physical desk).
    const fader = makeSvgFader({
      x: s.x, y: 188, h: 120,
      target: s.fader,
      current: -60, // start at the bottom (-∞); user pulls up or hits Match
      accent: '#cbd5e1',
      label: '',
    });
    sg.appendChild(fader);

    // Per-strip Match button — BELOW the fader so it doesn't intercept drags
    const mb = svgEl('g', { class: 'svg-match-btn', transform: `translate(${s.x - 12}, 325)` });
    mb.appendChild(svgEl('rect', { x: 0, y: 0, width: 24, height: 11, rx: 2 }));
    const mt = svgEl('text', { x: 12, y: 8 });
    mt.textContent = '▸';
    mb.appendChild(mt);
    mb.addEventListener('click', () => {
      KNOB_ROWS.forEach((row) => knobs[row.name]._render(s[row.name]));
      fader._render(s.fader);
    });
    sg.appendChild(mb);

    mountRoot.appendChild(sg);
    stripObjs.push({ s, knobs, fader });
  });

  // ---------- Right master column: FX block, AUX masters, master faders ----------
  // Targets reflect a typical "vocals/stream-forward" preset for this rig.
  const RIGHT_COL_TARGETS = {
    preset: 12,   // Plate reverb preset
    fxIn:   7,    // FX bus input near unity
    fxOut:  6,    // FX return level moderate
    aux1m:  7,    // monitor mix master near unity
    aux2m:  7,
    aux3m:  7.5,  // STREAM master — important: sets the level at the AUX 3 jack
    aux4m:  5,    // FX SEND master (AUX 4)
    fxFader:    0,   // FX return master at unity
    group1Fader: -60, // groups unused → -∞
    group2Fader: -60,
    mainFader:  0,   // MAIN MIX at unity
  };

  const rightColumnKnobs = {};
  const masterFaderObjs = {};

  // ---- FX block (preset / FX IN / FX OUT) — mount inside #fxBlockKnobs ----
  const fxBlockEl = document.getElementById('fxBlockKnobs');
  if (fxBlockEl) {
    const presetKnob = makeKnob('preset', 90,  64, RIGHT_COL_TARGETS.preset, RIGHT_COL_TARGETS.preset, 'PRESET');
    const fxInKnob   = makeKnob('fxIn',   135, 64, RIGHT_COL_TARGETS.fxIn,   0, 'FX IN');
    const fxOutKnob  = makeKnob('fxOut',  175, 64, RIGHT_COL_TARGETS.fxOut,  0, 'FX OUT');
    fxBlockEl.appendChild(presetKnob);
    fxBlockEl.appendChild(fxInKnob);
    fxBlockEl.appendChild(fxOutKnob);
    rightColumnKnobs.preset = presetKnob;
    rightColumnKnobs.fxIn   = fxInKnob;
    rightColumnKnobs.fxOut  = fxOutKnob;

    // Wrap preset _render so the on-panel preset display also updates
    const presetDisplay = document.getElementById('fxPresetDisplay');
    if (presetDisplay) {
      const orig = presetKnob._render;
      presetKnob._render = function (v) {
        orig(v);
        presetDisplay.textContent = Math.round(v).toString().padStart(2, '0');
      };
      presetKnob._render(RIGHT_COL_TARGETS.preset);
    }
  }

  // ---- AUX SEND MASTERS (4 knobs in a row) ----
  const auxMasterEl = document.getElementById('auxMasterKnobs');
  if (auxMasterEl) {
    const auxLayout = [
      { name: 'aux1m', x: 35,  label: 'AUX 1' },
      { name: 'aux2m', x: 78,  label: 'AUX 2' },
      { name: 'aux3m', x: 124, label: 'STREAM' },
      { name: 'aux4m', x: 170, label: 'FX SND' },
    ];
    for (const a of auxLayout) {
      const k = makeKnob(a.name, a.x, 50, RIGHT_COL_TARGETS[a.name], 0, a.label);
      auxMasterEl.appendChild(k);
      rightColumnKnobs[a.name] = k;
    }
  }

  // ---- Vertical SVG fader component ----
  function makeSvgFader(opts) {
    const { x, y, h, target, current, accent, label } = opts;
    const g = svgEl('g', { class: 'svg-fader', transform: `translate(${x}, ${y})` });
    g.dataset.value = current;
    g.dataset.target = target;

    // Track
    g.appendChild(svgEl('rect', {
      x: -1.5, y: 0, width: 3, height: h,
      fill: '#0a0d14', stroke: '#374151', 'stroke-width': '0.4', rx: 1.5,
    }));

    // Scale tick marks
    const stops = [
      [10, 0],  [5, 0.14], [0, 0.25], [-10, 0.50], [-30, 0.72], [-60, 1],
    ];
    for (const [, frac] of stops) {
      g.appendChild(svgEl('line', {
        x1: -3, y1: (frac * h).toFixed(1),
        x2: 3,  y2: (frac * h).toFixed(1),
        stroke: '#475569', 'stroke-width': '0.4',
      }));
    }

    function dbToPx(db) {
      if (db >= 10)  return 0;
      if (db >= 5)   return (10 - db) / 5  * (h * 0.14);
      if (db >= 0)   return h * 0.14 + (5 - db)  / 5  * (h * 0.11);
      if (db >= -10) return h * 0.25 + (0 - db)  / 10 * (h * 0.25);
      if (db >= -30) return h * 0.50 + (-10 - db) / 20 * (h * 0.22);
      if (db > -60)  return h * 0.72 + (-30 - db) / 30 * (h * 0.28);
      return h;
    }
    function pxToDb(p) {
      if (p <= 0)         return 10;
      if (p <= h * 0.14)  return 10 - p / (h * 0.14) * 5;
      if (p <= h * 0.25)  return 5  - (p - h * 0.14) / (h * 0.11) * 5;
      if (p <= h * 0.50)  return 0  - (p - h * 0.25) / (h * 0.25) * 10;
      if (p <= h * 0.72)  return -10 - (p - h * 0.50) / (h * 0.22) * 20;
      if (p < h)          return -30 - (p - h * 0.72) / (h * 0.28) * 30;
      return -60;
    }

    // Yellow suggest mark at target value
    g.appendChild(svgEl('rect', {
      class: 'fader-suggest',
      x: -5, y: (dbToPx(target) - 0.5).toFixed(1),
      width: 10, height: 1.2,
      fill: '#fde047', stroke: '#78350f', 'stroke-width': '0.2',
    }));

    // Thumb
    const thumb = svgEl('rect', {
      class: 'fader-thumb',
      x: -7, width: 14, height: 4.5, rx: 0.8,
      fill: accent || '#e5e7eb', stroke: '#0a0a0a', 'stroke-width': '0.4',
    });
    g.appendChild(thumb);

    // Label + value text
    const lbl = svgEl('text', { class: 'fader-label', x: 0, y: h + 7 });
    lbl.textContent = label;
    g.appendChild(lbl);
    const valText = svgEl('text', { class: 'fader-value', x: 0, y: h + 14 });
    g.appendChild(valText);

    function fmtDb(v) {
      if (v <= -60) return '−∞';
      return (v > 0 ? '+' : '') + v.toFixed(1).replace(/\.0$/, '') + ' dB';
    }
    function render(v) {
      g.dataset.value = v;
      thumb.setAttribute('y', (dbToPx(v) - 2.25).toFixed(2));
      valText.textContent = fmtDb(v);
      g.classList.toggle('matched', Math.abs(v - target) < 0.5);
    }
    render(current);

    // Drag the thumb vertically
    let dragging = false, lastClientY = 0, currentPx = dbToPx(current);
    thumb.addEventListener('pointerdown', (e) => {
      dragging = true;
      lastClientY = e.clientY;
      currentPx = dbToPx(parseFloat(g.dataset.value));
      thumb.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    thumb.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const ctm = g.getScreenCTM();
      const scaleY = ctm ? ctm.d : 1;
      const fine = e.shiftKey ? 5 : 1;
      currentPx = Math.max(0, Math.min(h, currentPx + (e.clientY - lastClientY) / scaleY / fine));
      lastClientY = e.clientY;
      render(pxToDb(currentPx));
    });
    function endDrag(e) {
      if (!dragging) return;
      dragging = false;
      try { thumb.releasePointerCapture(e.pointerId); } catch (_) {}
    }
    thumb.addEventListener('pointerup', endDrag);
    thumb.addEventListener('pointercancel', endDrag);
    thumb.addEventListener('dblclick', () => render(target));

    g._render = render;
    g._target = target;
    return g;
  }

  // ---- Master faders (FX · G1 · G2 · MAIN) ----
  const masterFadersEl = document.getElementById('masterFaders');
  if (masterFadersEl) {
    const faderLayout = [
      { name: 'fxFader',     x: 5,   label: 'FX',   accent: '#fbbf24' },
      { name: 'group1Fader', x: 35,  label: 'G1',   accent: '#3b82f6' },
      { name: 'group2Fader', x: 65,  label: 'G2',   accent: '#3b82f6' },
      { name: 'mainFader',   x: 105, label: 'MAIN', accent: '#ef4444' },
    ];
    for (const f of faderLayout) {
      const fader = makeSvgFader({
        x: f.x, y: 0, h: 100,
        target: RIGHT_COL_TARGETS[f.name],
        current: RIGHT_COL_TARGETS[f.name],
        accent: f.accent,
        label: f.label,
      });
      masterFadersEl.appendChild(fader);
      masterFaderObjs[f.name] = fader;
    }
  }

  // ---- HI-Z / MIC-LINE switches (per mono channel) ----
  document.querySelectorAll('#chInputSwitches .ch-sw').forEach((sw) => {
    sw.dataset.on = 'false';
    sw.addEventListener('click', () => {
      const on = sw.dataset.on !== 'true';
      sw.dataset.on = on ? 'true' : 'false';
      // For MIC/LINE: also flip the visible label
      if (sw.dataset.type === 'ml') {
        const txt = sw.querySelector('text');
        if (txt) txt.textContent = on ? 'LINE' : 'MIC';
      }
    });
  });

  // Global Match all / Reset
  const matchAllBtn = document.getElementById('svgMatchAll');
  if (matchAllBtn) matchAllBtn.addEventListener('click', () => {
    stripObjs.forEach(({ s, knobs, fader }) => {
      KNOB_ROWS.forEach((row) => knobs[row.name]._render(s[row.name]));
      if (fader) fader._render(s.fader);
    });
    Object.keys(rightColumnKnobs).forEach((k) => rightColumnKnobs[k]._render(RIGHT_COL_TARGETS[k]));
    Object.keys(masterFaderObjs).forEach((k) => masterFaderObjs[k]._render(RIGHT_COL_TARGETS[k]));
  });
  const resetAllBtn = document.getElementById('svgResetAll');
  if (resetAllBtn) resetAllBtn.addEventListener('click', () => {
    // Knobs + faders on every channel strip
    stripObjs.forEach(({ knobs, fader }) => {
      KNOB_ROWS.forEach((row) => knobs[row.name]._render(KNOB_SPECS[row.name].def));
      if (fader) fader._render(-60);
    });
    // Right-column knobs (incl. preset, which side-effects the on-panel display)
    Object.keys(rightColumnKnobs).forEach((k) => rightColumnKnobs[k]._render(KNOB_SPECS[k].def));
    // Master faders
    Object.keys(masterFaderObjs).forEach((k) => masterFaderObjs[k]._render(-60));
    // HI-Z / MIC-LINE switches back to "off / MIC"
    document.querySelectorAll('#chInputSwitches .ch-sw').forEach((sw) => {
      sw.dataset.on = 'false';
      if (sw.dataset.type === 'ml') {
        const txt = sw.querySelector('text');
        if (txt) txt.textContent = 'MIC';
      }
    });
    // MUTE buttons off
    document.querySelectorAll('.strip-mute').forEach((m) => {
      m.dataset.muted = 'false';
      const r = m.querySelector('rect');
      const t = m.querySelector('text');
      if (r) { r.setAttribute('fill', '#1f2937'); r.setAttribute('stroke', '#475569'); }
      if (t) t.setAttribute('style', 'font:700 4.5px ui-monospace,monospace;fill:#cbd5e1;pointer-events:none');
    });
    // Calibration state + ✓ badges
    state.calibration = {};
    if (calibOverlay) {
      calibOverlay.querySelectorAll('.strip-calibrated').forEach((el) => el.remove());
    }
    // If a calibration session was in flight, stop it cleanly
    if (state.calibrationSession) stopCalibration();
    // Rebuild current panel so its labels (e.g. "V1 ✓") refresh
    renderActions();
  });

  // ====================================================================
  //              PHASE 6: sections + add device under Routing
  // ====================================================================
  // The diagram is divided into named sections. New devices auto-pin to the
  // section that matches their classification (e.g. a wireless mic goes to
  // STAGE, a power amp goes to FOH). Each section keeps a layout cursor so
  // successive devices stack without overlapping.
  // Each section is a fixed region of the diagram with its own layout
  // cursor. addCustomDevice() ONLY places into the section the template
  // declares — no spillover into another section. Sections are drawn as
  // labeled dashed boxes whenever Routing mode is active so the user can
  // see exactly where new devices will land.
  // Sections are disjoint regions. addCustomDevice() only places into the
  // section the template names — never spills over. Each section has its
  // own cursor so successive devices stack inside that region.
  const SECTIONS = {
    // Right side of the upper stage column — clear of V1-V9 (which end at
    // x=190) and of the drum kit (which starts at y=490).
    mics:        { label: 'STAGE · MICS',         x: 195, y: 50,   w: 145, h: 430, dir: 'vertical',   cursor: 60 },
    // Below the keyboard area (which ends at y=960), still inside the stage column.
    instruments: { label: 'STAGE · INSTRUMENTS',  x: 18,  y: 980,  w: 322, h: 100, dir: 'horizontal', cursor: 28 },
    rx:          { label: 'RX & AUDIO LINK',      x: 360, y: 60,   w: 220, h: 980, dir: 'vertical',   cursor: 720 },
    foh:         { label: 'FOH & PA',             x: 1290, y: 460, w: 460, h: 150, dir: 'vertical',   cursor: 465 },
    monitor:     { label: 'MONITORS',             x: 1290, y: 830, w: 460, h: 200, dir: 'vertical',   cursor: 835 },
    stream:      { label: 'STREAM / RECORD',      x: 1100, y: 1300, w: 700, h: 200, dir: 'horizontal', cursor: 1100 },
  };

  // Catalog of device templates the user can add. Each one knows which
  // section it belongs in, its visual footprint, and the position of its
  // input/output jacks relative to the device origin.
  const DEVICE_TEMPLATES = {
    'wmic':  { name: 'Wireless Mic',  section: 'mics', w: 40,  h: 100,
               outputs: [{ id: 'rf',  label: 'RF',   dx: 20,  dy: 95 }],
               inputs: [],
               svg: '<use href="#wmic" width="40" height="100"/>' },
    'dmic':  { name: 'Dynamic Mic',   section: 'mics', w: 55,  h: 30,
               outputs: [{ id: 'xlr', label: 'XLR',  dx: 50,  dy: 15 }],
               inputs: [],
               svg: '<use href="#dmic" width="55" height="30"/>' },
    'di':    { name: 'DI Box',        section: 'instruments', w: 80,  h: 42,
               inputs:  [{ id: 'ts',  label: 'TS in', dx: 0,  dy: 21 }],
               outputs: [{ id: 'xlr', label: 'XLR',   dx: 78, dy: 21 }],
               svg: '<rect width="80" height="42" rx="4" fill="#1c1917" stroke="#fbbf24" stroke-width="1.2"/>' +
                    '<text x="40" y="16" text-anchor="middle" style="font:700 9px ui-sans-serif,system-ui;fill:#fde68a">DI</text>' +
                    '<text x="40" y="30" text-anchor="middle" style="font:7px ui-monospace,monospace;fill:#94a3b8">passive/active</text>' },
    'subm':  { name: 'Sub-mixer',     section: 'instruments', w: 110, h: 60,
               inputs:  [{ id: 'in1', label: 'in 1', dx: 0, dy: 15 },
                         { id: 'in2', label: 'in 2', dx: 0, dy: 30 },
                         { id: 'in3', label: 'in 3', dx: 0, dy: 45 }],
               outputs: [{ id: 'l',   label: 'L out', dx: 108, dy: 22 },
                         { id: 'r',   label: 'R out', dx: 108, dy: 38 }],
               svg: '<rect width="110" height="60" rx="3" fill="#1f2937" stroke="#7dd3fc" stroke-width="1.2"/>' +
                    '<text x="55" y="20" text-anchor="middle" style="font:700 9px ui-sans-serif,system-ui;fill:#93c5fd">Sub-mixer</text>' +
                    '<text x="55" y="52" text-anchor="middle" style="font:7px ui-monospace,monospace;fill:#94a3b8">3-in → stereo</text>' },
    'comp':  { name: 'Compressor',    section: 'foh',   w: 240, h: 50,
               inputs:  [{ id: 'in',  label: 'XLR in',  dx: 0,   dy: 25 }],
               outputs: [{ id: 'out', label: 'XLR out', dx: 238, dy: 25 }],
               svg: '<rect width="240" height="50" rx="4" fill="#2a2f3d" stroke="#475569"/>' +
                    '<text x="120" y="22" text-anchor="middle" style="font:700 11px ui-sans-serif,system-ui;fill:#cbd5e1">Compressor</text>' +
                    '<text x="120" y="38" text-anchor="middle" style="font:8px ui-monospace,monospace;fill:#94a3b8">e.g. dbx 166xs</text>' },
    'amp':   { name: 'Power amp',     section: 'foh',   w: 240, h: 60,
               inputs:  [{ id: 'in',  label: 'XLR in',     dx: 0,   dy: 30 }],
               outputs: [{ id: 's1',  label: 'Speakon 1',  dx: 235, dy: 22 },
                         { id: 's2',  label: 'Speakon 2',  dx: 235, dy: 40 }],
               svg: '<rect width="240" height="60" rx="4" fill="#2a2f3d" stroke="#374151"/>' +
                    '<text x="120" y="22" text-anchor="middle" style="font:700 11px ui-sans-serif,system-ui;fill:#cbd5e1">Power amp</text>' +
                    '<text x="120" y="40" text-anchor="middle" style="font:8px ui-monospace,monospace;fill:#94a3b8">stereo / dual mono</text>' },
    'spk':   { name: 'Speaker',       section: 'foh',   w: 150, h: 110,
               inputs:  [{ id: 'in',  label: 'Speakon in', dx: 75,  dy: 108 }],
               outputs: [],
               svg: '<rect width="150" height="110" rx="4" fill="#1f2937" stroke="#374151"/>' +
                    '<circle cx="75" cy="55" r="38" fill="#27272a" stroke="#3f3f46"/>' +
                    '<circle cx="75" cy="55" r="14" fill="#1c1917"/>' +
                    '<text x="75" y="100" text-anchor="middle" style="font:700 9px ui-sans-serif,system-ui;fill:#f87171">Speaker</text>' },
    'wedge': { name: 'Stage wedge',   section: 'monitor', w: 150, h: 110,
               inputs:  [{ id: 'in', label: 'Speakon in', dx: 130, dy: 60 }],
               outputs: [],
               svg: '<path d="M 15 0 L 135 0 L 150 70 L 0 70 Z" fill="#1f2937" stroke="#374151"/>' +
                    '<ellipse cx="55" cy="42" rx="32" ry="22" fill="#27272a" stroke="#3f3f46"/>' +
                    '<text x="75" y="92" text-anchor="middle" style="font:700 9px ui-sans-serif,system-ui;fill:#fde047">Stage wedge</text>' },
    'iface': { name: 'Audio interface', section: 'stream', w: 220, h: 90,
               inputs:  [{ id: 'in1', label: 'IN 1', dx: 0,   dy: 35 },
                         { id: 'in2', label: 'IN 2', dx: 0,   dy: 60 }],
               outputs: [{ id: 'out', label: 'USB',  dx: 218, dy: 45 }],
               svg: '<rect width="220" height="90" rx="6" fill="#0c2418" stroke="#22c55e" stroke-width="2"/>' +
                    '<text x="110" y="24" text-anchor="middle" style="font:700 12px ui-sans-serif,system-ui;fill:#bbf7d0">USB Audio Interface</text>' +
                    '<text x="110" y="75" text-anchor="middle" style="font:8px ui-monospace,monospace;fill:#86efac">2× XLR/TRS combo · USB-B</text>' },
  };

  let customDeviceCounter = 0;
  state.customDevices = [];

  let customDevicesG = document.getElementById('customDevices');
  if (!customDevicesG) {
    customDevicesG = svgEl('g', { id: 'customDevices' });
    // Insert BEFORE jackHotspots so device visuals don't intercept clicks
    // intended for jack hotspots (which need to stay on top).
    const jackHotspotsRef = document.getElementById('jackHotspots');
    if (mainSvg) {
      if (jackHotspotsRef) mainSvg.insertBefore(customDevicesG, jackHotspotsRef);
      else mainSvg.appendChild(customDevicesG);
    }
  }

  function addCustomDevice(templateId) {
    const tpl = DEVICE_TEMPLATES[templateId];
    if (!tpl) return null;
    const sec = SECTIONS[tpl.section];
    if (!sec) return null;
    customDeviceCounter++;
    const id = `custom-dev-${templateId}-${customDeviceCounter}`;

    // Position: stack within the section using its layout cursor
    let x, y;
    if (sec.dir === 'vertical') {
      x = sec.x + 10;
      y = sec.cursor;
      sec.cursor += tpl.h + 24;
    } else {
      x = sec.cursor;
      y = sec.y + 10;
      sec.cursor += tpl.w + 24;
    }

    const g = svgEl('g', {
      class: 'custom-device',
      'data-device-id': id,
      transform: `translate(${x}, ${y})`,
    });
    // Visual: insert template SVG markup via a temporary container
    const tmp = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    tmp.innerHTML = tpl.svg;
    while (tmp.firstChild) g.appendChild(tmp.firstChild);
    // Top label
    const lbl = svgEl('text', {
      x: tpl.w / 2, y: -4,
      'text-anchor': 'middle',
      style: 'font:700 8.5px ui-sans-serif,system-ui;fill:#cbd5e1;pointer-events:none',
    });
    lbl.textContent = `${tpl.name} #${customDeviceCounter}`;
    g.appendChild(lbl);

    customDevicesG.appendChild(g);

    // Register jacks so Routing-mode hotspots include them
    const jackIds = [];
    for (const o of (tpl.outputs || [])) {
      const jid = `${id}-out-${o.id}`;
      const jack = { id: jid, label: `${tpl.name} #${customDeviceCounter} ${o.label}`, x: x + o.dx, y: y + o.dy, kind: 'device-output' };
      JACKS.push(jack);
      jackById[jid] = jack;
      jackIds.push(jid);
    }
    for (const i of (tpl.inputs || [])) {
      const jid = `${id}-in-${i.id}`;
      const jack = { id: jid, label: `${tpl.name} #${customDeviceCounter} ${i.label}`, x: x + i.dx, y: y + i.dy, kind: 'device-input' };
      JACKS.push(jack);
      jackById[jid] = jack;
      jackIds.push(jid);
    }

    state.customDevices.push({ id, templateId, x, y, jackIds });
    state.actionStack.push({ type: 'add-device', deviceId: id });

    // Refresh hotspots so the new jacks are clickable immediately
    if (state.mode === 'routing') showJackHotspots();
    return id;
  }

  function removeCustomDevice(deviceId) {
    const idx = state.customDevices.findIndex((d) => d.id === deviceId);
    if (idx < 0) return;
    const dev = state.customDevices[idx];
    // Remove SVG element
    const el = customDevicesG.querySelector(`[data-device-id="${deviceId}"]`);
    if (el && el.parentNode) el.parentNode.removeChild(el);
    // Drop its jacks from registry
    for (const jid of dev.jackIds) {
      const i = JACKS.findIndex((j) => j.id === jid);
      if (i >= 0) JACKS.splice(i, 1);
      delete jackById[jid];
    }
    state.customDevices.splice(idx, 1);
    if (state.mode === 'routing') showJackHotspots();
  }

  // Visible section outlines (rendered while Routing mode is on)
  let sectionOutlinesG = null;
  function showSectionOutlines() {
    if (sectionOutlinesG) sectionOutlinesG.remove();
    sectionOutlinesG = svgEl('g', { id: 'sectionOutlines' });
    Object.values(SECTIONS).forEach((s) => {
      const rect = svgEl('rect', {
        x: s.x, y: s.y, width: s.w, height: s.h, rx: 6,
        fill: 'none', stroke: '#60a5fa',
        'stroke-width': 0.5, 'stroke-dasharray': '6 4',
        opacity: 0.4,
      });
      const lbl = svgEl('text', {
        x: s.x + 8, y: s.y + 12,
        style: 'font:700 9px ui-monospace,monospace;fill:#60a5fa;opacity:0.7;pointer-events:none',
      });
      lbl.textContent = s.label;
      sectionOutlinesG.appendChild(rect);
      sectionOutlinesG.appendChild(lbl);
    });
    if (mainSvg) mainSvg.insertBefore(sectionOutlinesG, customDevicesG);
  }
  function hideSectionOutlines() {
    if (sectionOutlinesG) { sectionOutlinesG.remove(); sectionOutlinesG = null; }
  }

  // Splice the device-adder UI into the routing panel by wrapping the
  // existing MODE_PANELS.routing. We do this lazily — first call grabs the
  // existing factory, then replaces it.
  const _origRoutingPanel = MODE_PANELS.routing;
  MODE_PANELS.routing = function () {
    const out = _origRoutingPanel();
    // Append a divider, "Add device" select, and add button
    const divider = document.createElement('span');
    divider.style.cssText = 'width:1px;height:24px;background:#1e293b;display:inline-block;margin:0 4px';
    out.push(divider);

    const lbl = document.createElement('span');
    lbl.className = 'toolbar-label';
    lbl.textContent = 'Add device';
    out.push(lbl);

    const sel = document.createElement('select');
    sel.id = 'addDeviceSel';
    sel.className = 'toolbar-select';
    sel.appendChild(new Option('— pick type —', ''));
    // Group by section for clarity
    Object.entries(SECTIONS).forEach(([secId, sec]) => {
      const group = document.createElement('optgroup');
      group.label = sec.label;
      Object.entries(DEVICE_TEMPLATES).forEach(([tid, tpl]) => {
        if (tpl.section === secId) {
          const o = new Option(tpl.name, tid);
          group.appendChild(o);
        }
      });
      if (group.children.length) sel.appendChild(group);
    });
    out.push(sel);

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'toolbar-action-btn primary';
    addBtn.textContent = '＋ Add to section';
    addBtn.disabled = true;
    sel.addEventListener('change', () => { addBtn.disabled = !sel.value; });
    addBtn.addEventListener('click', () => {
      if (!sel.value) return;
      const id = addCustomDevice(sel.value);
      if (id) {
        sel.value = '';
        addBtn.disabled = true;
        setBanner(`Added "${DEVICE_TEMPLATES[id.split('-')[2]]?.name || 'device'}" to its section.`, 'warn');
      }
    });
    out.push(addBtn);

    // Show count
    const count = document.createElement('span');
    count.className = 'toolbar-status';
    count.textContent = `${state.customDevices.length} custom device${state.customDevices.length === 1 ? '' : 's'}`;
    out.push(count);

    return out;
  };

  // Hook section outlines into mode switching
  const _origEnterRouting = enterRoutingMode;
  enterRoutingMode = function () {
    _origEnterRouting();
    showSectionOutlines();
  };
  const _origExitRouting = exitRoutingMode;
  exitRoutingMode = function () {
    _origExitRouting();
    hideSectionOutlines();
  };
  // If we're already in routing mode (e.g. via the Default preset), refresh
  if (state.mode === 'routing') {
    showSectionOutlines();
    renderActions();
  }

  // ====================================================================
  //   PHASE 7: per-device selection + delete (default and custom)
  // ====================================================================
  // Every top-level <g> directly inside the main SVG gets tagged as a
  // "device" so it can be uniquely selected. Click selects (yellow dashed
  // outline + name in toolbar); the Delete button removes custom devices
  // outright and HIDES default devices so Undo can restore them. Location
  // can't be changed — devices stay pinned to whatever section they sit in.

  let selectedDeviceEl = null;

  function deviceLabelFor(g) {
    // Prefer an explicit data-device-name; otherwise scrape the first label-ish
    // text node in the group (brand, label, col-title).
    if (g.dataset.deviceName) return g.dataset.deviceName;
    const t = g.querySelector('text.brand, text.label, text.col-title');
    if (t && t.textContent.trim()) return t.textContent.trim().slice(0, 60);
    return g.dataset.deviceId || 'Unnamed device';
  }

  function tagDefaultDevices() {
    if (!mainSvg) return;
    let n = 0;
    Array.from(mainSvg.children).forEach((g) => {
      if (g.tagName.toLowerCase() !== 'g') return;
      // Skip overlay layers — those aren't user-facing devices.
      if (g.id && /^(customCables|previewCable|jackHotspots|customDevices|sectionOutlines|calibOverlay)$/.test(g.id)) return;
      if (g.dataset.deviceId) return; // already tagged (custom devices)
      n++;
      g.dataset.deviceId = `default-dev-${n}`;
      g.dataset.deviceName = deviceLabelFor(g);
    });
  }
  tagDefaultDevices();

  // Outline overlay for the currently-selected device
  function showDeviceOutline(g) {
    hideDeviceOutline();
    if (!g || !mainSvg) return;
    let x, y, w, h;
    try {
      // getBBox returns local coords (pre-transform); add the group's
      // translate so the outline sits at the right place in the parent.
      const bbox = g.getBBox();
      const tAttr = g.getAttribute('transform') || '';
      const m = tAttr.match(/translate\(\s*(-?[\d.]+)[\s,]+(-?[\d.]+)\s*\)/);
      const dx = m ? parseFloat(m[1]) : 0;
      const dy = m ? parseFloat(m[2]) : 0;
      x = bbox.x + dx - 6;
      y = bbox.y + dy - 6;
      w = bbox.width + 12;
      h = bbox.height + 12;
    } catch (_) { return; }
    const outline = svgEl('rect', {
      id: 'deviceOutline',
      x, y, width: w, height: h, rx: 6,
      fill: 'none',
      stroke: '#fbbf24',
      'stroke-width': 2.2,
      'stroke-dasharray': '6 3',
      'pointer-events': 'none',
    });
    mainSvg.appendChild(outline);
  }
  function hideDeviceOutline() {
    const el = document.getElementById('deviceOutline');
    if (el) el.remove();
  }

  function selectDevice(g) {
    if (selectedDeviceEl === g) return;
    selectedDeviceEl = g;
    showDeviceOutline(g);
    renderActions();
  }
  function deselectDevice() {
    if (!selectedDeviceEl) return;
    selectedDeviceEl = null;
    hideDeviceOutline();
    renderActions();
  }

  function deleteSelectedDevice() {
    if (!selectedDeviceEl) return;
    const g = selectedDeviceEl;
    const id = g.dataset.deviceId || '';
    const isCustom = id.startsWith('custom-dev-');
    if (isCustom) {
      removeCustomDevice(id);
      state.actionStack.push({ type: 'remove-custom-device', deviceId: id, element: g });
    } else {
      // Default device — hide so Undo can restore it.
      g.style.display = 'none';
      state.actionStack.push({ type: 'hide-default-device', element: g });
    }
    deselectDevice();
  }

  // Delegated click handler. We attach to the main SVG so cable/jack
  // handlers (which already call e.stopPropagation) still get first crack.
  const INTERACTIVE_SEL = '.svg-knob, .svg-fader, .ch-sw, .strip-mute, .jack-hotspot, .ch-hotspot, .svg-match-btn, .svg-reset-btn, path[class*="cable-"]';
  if (mainSvg) {
    mainSvg.addEventListener('click', (e) => {
      if (state.mode !== 'routing') return;
      if (state.routing.addStep || state.routing.rerouteStep) return;
      // Ignore clicks on interactive UI elements inside any device.
      if (e.target.closest && e.target.closest(INTERACTIVE_SEL)) return;
      // Walk up to find the device group.
      let el = e.target;
      while (el && el !== mainSvg) {
        if (el.dataset && el.dataset.deviceId) {
          e.stopPropagation();
          selectDevice(el);
          return;
        }
        el = el.parentNode;
      }
      // Click was on bare background — deselect any current device.
      deselectDevice();
    });
  }

  // Clean selection when leaving Routing mode.
  const _origExitRouting2 = exitRoutingMode;
  exitRoutingMode = function () {
    _origExitRouting2();
    deselectDevice();
  };

  // Extend the undo handler to reverse device-related actions.
  const _origUndo = undoLastAction;
  undoLastAction = function () {
    const top = state.actionStack[state.actionStack.length - 1];
    if (!top) return;
    if (top.type === 'hide-default-device') {
      state.actionStack.pop();
      if (top.element) top.element.style.display = '';
      renderActions();
      return;
    }
    if (top.type === 'remove-custom-device') {
      state.actionStack.pop();
      // Re-mount the custom device's SVG group and re-register its jacks
      if (top.element && customDevicesG) customDevicesG.appendChild(top.element);
      // (Note: jack hotspots refresh on next showJackHotspots call.)
      if (state.mode === 'routing') showJackHotspots();
      renderActions();
      return;
    }
    if (top.type === 'add-device') {
      // The original add-device action stays — let removeCustomDevice handle it
      state.actionStack.pop();
      removeCustomDevice(top.deviceId);
      renderActions();
      return;
    }
    _origUndo();
  };

  // Inject the selected-device chip + Delete button into the routing panel
  const _origRoutingPanel2 = MODE_PANELS.routing;
  MODE_PANELS.routing = function () {
    const out = _origRoutingPanel2();
    if (selectedDeviceEl) {
      const div = document.createElement('span');
      div.style.cssText = 'width:1px;height:24px;background:#1e293b;display:inline-block;margin:0 4px';
      out.push(div);
      const chip = document.createElement('span');
      chip.className = 'toolbar-status ok';
      chip.textContent = `▣ ${selectedDeviceEl.dataset.deviceName || 'device'}`;
      out.push(chip);
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'toolbar-action-btn danger';
      delBtn.textContent = '🗑 Delete device';
      delBtn.addEventListener('click', deleteSelectedDevice);
      out.push(delBtn);
      const deselBtn = document.createElement('button');
      deselBtn.type = 'button';
      deselBtn.className = 'toolbar-action-btn';
      deselBtn.textContent = 'Deselect';
      deselBtn.addEventListener('click', deselectDevice);
      out.push(deselBtn);
    } else {
      const hint = document.createElement('span');
      hint.className = 'toolbar-status';
      hint.textContent = 'tip: click a device body (not a knob/jack) to select it for deletion';
      out.push(hint);
    }
    return out;
  };
})();
