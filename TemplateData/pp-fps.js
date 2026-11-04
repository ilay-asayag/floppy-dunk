// PlayPerfect 60 fps shim — keeps a Unity WebGL game at 60 fps inside Apple WebKit
// (WKWebView / Safari) while iOS is in Low Power Mode. Must load BEFORE the Unity loader.
//
// Why: in Low Power Mode WebKit runs the page's rendering update at 30 fps. That caps
// main-thread requestAnimationFrame, aligns main-thread timers to 30 ms, and presents a
// normal <canvas> only 30 times a second. Two WebKit paths escape it (verified on device
// with Tools/webgl-low-power-probe, mode C + pace:timer):
//   1. Timers inside a Web Worker are not aligned, so a worker can tick at 60 Hz and
//      post each tick to the page. requestAnimationFrame is replaced by that beat, so
//      Unity's main loop (and its display-rate probe) runs at 60.
//   2. A canvas handed to an OffscreenCanvas (transferControlToOffscreen) pushes each
//      frame straight to its layer instead of waiting for the page's rendering update.
//      Unity keeps the <canvas> element (input, layout); only getContext and the
//      width/height backing size are forwarded to the OffscreenCanvas.
//
// Both paths cost CPU/GPU when the page is NOT capped (the OffscreenCanvas copy roughly
// doubles total process CPU on an iPhone-sized canvas), so they are only used when the
// cap is really there:
//   - From the moment this file runs, a requestAnimationFrame sampler watches the page's
//     frame interval: the median is ~33 ms under the Low Power cap and ~17 ms (or ~8 ms on
//     a 120 Hz screen) without it, and a few long boot frames do not move a median. Unity
//     creating its WebGL context is the point of
//     no return (a canvas cannot be handed to an OffscreenCanvas afterwards), so the
//     decision is taken in canvas.getContext: capped -> shim on, otherwise the canvas is
//     left completely untouched and nothing keeps running.
//   - While the shim is on, a short re-check every few seconds hands frames back to the
//     page's own rAF when the cap is gone (Low Power Mode switched off mid-session) and
//     back to the beat when it returns. The OffscreenCanvas stays either way.
//   - The beat is pull-based: at most one tick is ever in flight and the next one is
//     requested only after the previous frame ran, so a slow frame can never leave a
//     backlog of ticks that starves the page's rendering update and timers.
//
// If anything is unsupported or throws before Unity gets its context, the page is left
// untouched. Off switch: ?pp60=0. Forced on any browser (desktop testing): ?pp60=1.
// A host that knows the power state can say so instead of letting the page measure it
// (a hidden web view may not run requestAnimationFrame during boot, so the measurement
// can come back empty): a "PPLowPower/1" or "PPLowPower/0" token in the user agent, read
// when this file runs, or PlayPerfectFps.setLowPower(true|false|null) later (null = back to
// measuring). Status for the boot log: window.PlayPerfectFps =
// { active, mode: 'off' | 'pending' | 'page' | 'beat', status, samples, setLowPower }.
(function () {
    'use strict';

    var FRAME_MS = 1000 / 60;
        var KEEP = 120;           // intervals remembered
    var MIN_SAMPLES = 6;      // intervals needed before the sampler decides
    var CAPPED_MEDIAN = 28;   // median interval (ms) at or above this = capped (30 Hz is ~33) ...
    var FREE_MEDIAN = 22;     // ... at or below this = not capped (60 Hz is ~17); in between = unknown
    var RECHECK_EVERY_MS = 4000;
    var RECHECK_FOR_MS = 1200;

    var state = window.PlayPerfectFps = { active: false, mode: 'off', status: 'off', setLowPower: setLowPower };

    var nativeRaf = null;
    var nativeCaf = null;
    var hint = null;          // set by setLowPower: true / false / null
    var forced = false;       // ?pp60=1
    var stickyBeat = false;   // the page went back to its own rAF and was capped again within a minute
    var pageSince = 0;
    var decided = false;
    var offscreen = null;
    var sampler = null;
    var beat = null;

    function flag() {
        try { return new URLSearchParams(window.location.search).get('pp60'); } catch (e) { return null; }
    }

    function isAppleWebKit() {
        var ua = navigator.userAgent || '';
        return /AppleWebKit/.test(ua) && !/Chrome|Chromium|Android/.test(ua);
    }

    function supportsOffscreenWebGl() {
        if (typeof Worker !== 'function' || typeof Blob !== 'function' || !window.URL || !URL.createObjectURL) return false;
        if (typeof OffscreenCanvas !== 'function') return false;
        if (!('transferControlToOffscreen' in HTMLCanvasElement.prototype)) return false;
        try {
            var probe = new OffscreenCanvas(1, 1);
            var gl = probe.getContext('webgl2') || probe.getContext('webgl');
            if (!gl) return false;
            var lose = gl.getExtension('WEBGL_lose_context');
            if (lose) lose.loseContext();
            return true;
        } catch (e) {
            return false;
        }
    }

    // ─── 1. is the page's rendering update capped? ────────────────────────

    // Watches page requestAnimationFrame intervals. verdict(): true = capped (30 Hz),
    // false = not capped, null = not enough data yet. Gaps over 250 ms (hidden page,
    // long task) are not samples.
    function makeSampler() {
        var iv = [];
        var last = 0;
        var running = false;
        var stopAt = 0;

        function tick(t) {
            if (!running) return;
            if (last && t - last < 250) {
                iv.push(t - last);
                if (iv.length > KEEP) iv.shift();
            }
            last = t;
            if (stopAt && t >= stopAt) { running = false; return; }
            nativeRaf(tick);
        }

        return {
            start: function (forMs) {
                stopAt = forMs ? performance.now() + forMs : 0;
                if (running) return;
                running = true;
                last = 0;
                iv = [];
                nativeRaf(tick);
            },
            stop: function () { running = false; },
            isRunning: function () { return running; },
            verdict: function () {
                if (iv.length < MIN_SAMPLES) { state.samples = iv.length + ' intervals'; return null; }
                var sorted = iv.slice().sort(function (a, b) { return a - b; });
                var median = sorted[sorted.length >> 1];
                state.samples = iv.length + ' intervals, median ' + median.toFixed(1) + ' ms';
                if (median >= CAPPED_MEDIAN) return true;
                return median <= FREE_MEDIAN ? false : null;
            },
        };
    }

    function capped() {
        if (forced) return true;
        if (hint !== null) return hint;
        return sampler ? sampler.verdict() : null;
    }

    function setLowPower(on) {
        hint = on === null || on === undefined ? null : !!on;
        if (offscreen) {
            applyMode();
            if (hint === null && !forced) scheduleRecheck();
        }
    }

    // ─── 2. canvas → OffscreenCanvas (lazy, at getContext) ────────────────

    function moveCanvasOffscreen(el) {
        var off = el.transferControlToOffscreen();
        off.width = el.width;
        off.height = el.height;

        // Reads and writes of the backing size go to the OffscreenCanvas; the element's
        // own setters would throw once control is transferred.
        ['width', 'height'].forEach(function (prop) {
            Object.defineProperty(el, prop, {
                configurable: true,
                get: function () { return off[prop]; },
                set: function (v) { off[prop] = v; },
            });
        });
        // Emscripten stores its context record on ctx.canvas (the OffscreenCanvas) but
        // looks it up on the element when resizing.
        Object.defineProperty(el, 'GLctxObject', {
            configurable: true,
            get: function () { return off.GLctxObject; },
            set: function (v) { off.GLctxObject = v; },
        });
        // Context loss fires on the OffscreenCanvas; Unity listens on the element.
        ['webglcontextlost', 'webglcontextrestored'].forEach(function (type) {
            off.addEventListener(type, function (e) {
                var copy = new Event(type, { cancelable: true });
                el.dispatchEvent(copy);
                if (copy.defaultPrevented) e.preventDefault();
            });
        });
        return off;
    }

    // ─── 3. pull-based worker beat replacing requestAnimationFrame ────────

    // The worker only sleeps: it answers each request when the asked wall-clock time (ms since
    // the epoch) arrives. Worker timers are not aligned to the capped rendering update.
    var WORKER_SRC =
        'onmessage = function (e) {' +
        '  var wait = e.data - (performance.timeOrigin + performance.now());' +
        '  setTimeout(function () { postMessage(0); }, wait > 0 ? wait : 0);' +
        '};';

    function makeBeat() {
        var queue = [];
        var nextId = 0;
        var on = false;
        var armed = false;
        var inFlush = false;
        var ticked = false;
        var broken = false;
        var due = 0;
        var asked = 0;          // when the pending tick was asked for
        var slop = 0;           // learned timer + message latency (ms), asked for early
        var worker = new Worker(URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' })));

        function fail(reason) {
            if (broken) return;
            broken = true;
            state.status = 'beat fell back to page rAF: ' + reason;
            state.mode = 'page';
            try { worker.terminate(); } catch (e) { /* already gone */ }
            handBack();
        }

        function handBack() {
            on = false;
            var pending = queue;
            queue = [];
            for (var i = 0; i < pending.length; i++) nativeRaf(pending[i].cb);
        }

        // Ask for the next tick, no earlier than `due`; never more than one in flight.
        function arm() {
            if (!on || armed || inFlush || document.hidden || queue.length === 0) return;
            armed = true;
            var now = performance.now();
            if (due < now - 2 * FRAME_MS) due = now;
            asked = Math.max(due - slop, now);
            worker.postMessage(performance.timeOrigin + asked);
        }

        function flush() {
            var batch = queue;
            queue = [];
            var now = performance.now();
            inFlush = true;
            for (var i = 0; i < batch.length; i++) {
                try {
                    batch[i].cb(now);
                } catch (err) {
                    setTimeout(function () { throw err; }, 0);
                }
            }
            inFlush = false;
            // Next slot is one frame after this one; a late frame is not made up for, it
            // just starts the next one right away.
            due += FRAME_MS;
            var after = performance.now();
            if (due < after) due = after;
        }

        worker.onmessage = function () {
            armed = false;
            ticked = true;
            if (!on || document.hidden) return;
            // How late the tick came past the time it was asked for: the part of the next
            // wait to shave off. Clamped so one stalled page cannot teach a huge value.
            var late = performance.now() - asked;
            slop += 0.1 * (Math.min(Math.max(late, 0), 6) - slop);
            flush();
            arm();
        };
        worker.onerror = function (e) { fail('worker error ' + (e && e.message ? e.message : '')); };

        document.addEventListener('visibilitychange', function () { if (!document.hidden) arm(); });

        return {
            request: function (cb) {
                var id = -(++nextId);
                queue.push({ id: id, cb: cb });
                arm();
                return id;
            },
            cancel: function (id) {
                for (var i = 0; i < queue.length; i++) {
                    if (queue[i].id === id) { queue.splice(i, 1); return; }
                }
            },
            enable: function () {
                if (broken || on) return !broken;
                on = true;
                ticked = false;
                due = performance.now();
                arm();
                setTimeout(function () { if (on && !ticked && !document.hidden) fail('worker never ticked'); }, 2000);
                return true;
            },
            disable: function () { if (on) handBack(); },
            isOn: function () { return on; },
        };
    }

    // One stable wrapper: Unity keeps calling window.requestAnimationFrame; where the call
    // goes (page rAF or the beat) is decided per call.
    function installRafWrapper() {
        beat = makeBeat();
        window.requestAnimationFrame = function (cb) {
            return beat.isOn() ? beat.request(cb) : nativeRaf(cb);
        };
        window.cancelAnimationFrame = function (id) {
            if (id < 0) beat.cancel(id); else nativeCaf(id);
        };
    }

    // ─── 4. beat on/off follows the cap while the shim is active ──────────

    var recheckTimer = 0;

    function applyMode() {
        if (!offscreen || !beat) return;
        var c = capped();
        if (c === true && !beat.isOn()) {
            if (pageSince && performance.now() - pageSince < 60000) stickyBeat = true;
            if (beat.enable()) state.mode = 'beat';
        } else if (c === false && beat.isOn() && !stickyBeat) {
            beat.disable();
            state.mode = 'page';
            pageSince = performance.now();
        }
    }

    function scheduleRecheck() {
        if (recheckTimer) return;
        recheckTimer = setInterval(function () {
            if (hint !== null || document.hidden) return;
            sampler.start(RECHECK_FOR_MS);
            setTimeout(applyMode, RECHECK_FOR_MS + 100);
        }, RECHECK_EVERY_MS);
    }

    // ─── boot ─────────────────────────────────────────────────────────────

    function decide(el, nativeGetContext, args) {
        decided = true;
        var c = capped();
        if (c !== true) {
            state.mode = 'off';
            state.status = c === false ? 'off (page not capped)' : 'off (cap unknown at getContext)';
            if (sampler) sampler.stop();
            return nativeGetContext.apply(el, args);
        }
        try {
            if (!supportsOffscreenWebGl()) {
                state.status = 'off (no OffscreenCanvas WebGL / Worker)';
                if (sampler) sampler.stop();
                return nativeGetContext.apply(el, args);
            }
            offscreen = moveCanvasOffscreen(el);
            installRafWrapper();
            state.active = true;
            state.mode = 'page';
            state.status = 'on (OffscreenCanvas + worker beat, capped page)';
            applyMode();
            sampler.stop();
            if (!forced && hint === null) scheduleRecheck();
        } catch (e) {
            state.status = 'off (setup threw: ' + (e && e.message ? e.message : e) + ')';
            if (sampler) sampler.stop();
            return nativeGetContext.apply(el, args);
        }
        return offscreen.getContext.apply(offscreen, args);
    }

    try {
        var f = flag();
        forced = f === '1';
        var ua = /PPLowPower\/([01])/.exec(navigator.userAgent || '');
        if (ua) hint = ua[1] === '1';
        if (f === '0') { state.status = 'off (?pp60=0)'; return; }
        if (f !== '1' && !isAppleWebKit()) { state.status = 'off (not Apple WebKit)'; return; }
        if (typeof window.requestAnimationFrame !== 'function') { state.status = 'off (no requestAnimationFrame)'; return; }

        var el = document.getElementById('unity-canvas') || document.querySelector('canvas');
        if (!el) { state.status = 'off (no canvas found)'; return; }

        nativeRaf = window.requestAnimationFrame.bind(window);
        nativeCaf = window.cancelAnimationFrame.bind(window);
        sampler = makeSampler();
        sampler.start(0);
        state.mode = 'pending';
        state.status = 'measuring the page frame rate';

        // Own property so Unity's GL.createContext, which captures canvas.getContext and then
        // wraps it for Safari, ends up calling this. Until the first call nothing else changes.
        var protoGetContext = HTMLCanvasElement.prototype.getContext;
        el.getContext = function () {
            if (decided) {
                return offscreen ? offscreen.getContext.apply(offscreen, arguments) : protoGetContext.apply(el, arguments);
            }
            return decide(el, protoGetContext, arguments);
        };
    } catch (e) {
        state.status = 'off (setup threw: ' + (e && e.message ? e.message : e) + ')';
    }
})();
