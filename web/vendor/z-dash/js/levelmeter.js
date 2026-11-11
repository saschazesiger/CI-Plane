/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Audio level meter (DS.levelmeter): the live level of a microphone from a
 * page-supplied AnalyserNode, or from values the page sets, with the
 * ballistics of a meter and a peak that holds.
 *
 *   <div class="ds-levelmeter" data-ds-levelmeter> label, track (role="meter"), fill, peak, note </div>
 *   const meter = DS.levelmeter.create(el, { analyser });   // reads it every frame
 *   const stop = meter.listen(otherAnalyser);                // or later; stop() lets go
 *   meter.set(0.4);                                          // or the page's own value, 0 ... 1
 *   DS.levelmeter.level(samples);                            // 0 ... 1 of a block of samples
 *   DS.levelmeter.peak(samples);                             // its sample peak, 0 ... 1
 *
 * The level of a block of samples is its RMS in dBFS, from -60 dB (0) to
 * 0 dB (1), so speech sits in the middle of the track and silence at its
 * start. The meter rises at once and falls over --ds-dur-glide per full
 * scale; the peak mark holds --ds-hold-status, then falls the same way.
 * Clipping is decided on the sample peak, not on the RMS (a full-scale
 * sine reads -3 dB RMS, clipped speech far less): a block whose peak
 * reaches -1 dBFS is loud. A page's own value (set()) counts as loud when
 * it gives a sample peak there (set(value, { peak })), else when the
 * level itself reaches -1 dBFS. Loud: data-state="loud" on .ds-levelmeter
 * and the note says it ("Too loud", levelmeterLoud) until it has stayed
 * below for --ds-hold-status. The track's aria-valuenow (0 ... 100) and
 * aria-valuetext ("-18 dB", levelmeterValue) follow at most once per
 * --ds-hold-status, so a screen reader is not flooded; the note's own
 * aria-live says "Too loud". The controller sends ds:change ({ loud }) when
 * the loud state changes, never per frame.
 *
 * A track with aria-disabled="true" (a
 * muted microphone, the page's) shows nothing. The loop runs only while
 * an analyser is attached or a fall is under way, and stops on destroy().
 *
 * Writes: --ds-levelmeter-level and --ds-levelmeter-peak (runtime
 * properties) on the track, aria-valuenow and aria-valuetext there,
 * data-state on .ds-levelmeter, hidden on the peak, the note's text.
 *
 * ES2022. No Progressive: features.
 */
import { define, emit, t } from './core.js';
import { motionDuration } from './motion.js';
import { own, disown } from './dom.js';

/** The bottom of the scale, in dBFS: the level 0. */
const FLOOR_DB = -60;
/** From here up a sample peak is loud (clipping is near), in dBFS. */
const LOUD_DB = -1;
/** LOUD_DB as a sample amplitude: about 0.891. */
const LOUD_PEAK = 10 ** (LOUD_DB / 20);

/**
 * The level of a block of samples (floats from -1 to 1, as
 * AnalyserNode.getFloatTimeDomainData() gives them): its RMS in dBFS mapped
 * from `floor` (0) to 0 dB (1). 0 for silence or an empty block.
 * @param {ArrayLike<number>} samples
 * @param {{ floor?: number }} [options]
 * @returns {number}
 */
export function level(samples, options = {}) {
  const floor = Number.isFinite(options.floor) && options.floor < 0 ? options.floor : FLOOR_DB;
  const count = samples?.length ?? 0;
  if (!count) return 0;
  let sum = 0;
  for (let i = 0; i < count; i += 1) {
    const value = Number(samples[i]) || 0;
    sum += value * value;
  }
  const rms = Math.sqrt(sum / count);
  if (!(rms > 0)) return 0;
  const db = 20 * Math.log10(rms);
  return Math.min(1, Math.max(0, (db - floor) / -floor));
}

/**
 * The sample peak of a block of samples: the largest |x|, at most 1 (a
 * clipped block reads 1). 0 for silence or an empty block. A peak of
 * 10 ** (-1 / 20), about 0.891 (-1 dBFS), or more is loud.
 * @param {ArrayLike<number>} samples
 * @returns {number}
 */
export function peak(samples) {
  const count = samples?.length ?? 0;
  let most = 0;
  for (let i = 0; i < count; i += 1) {
    const value = Math.abs(Number(samples[i]) || 0);
    if (value > most) most = value;
  }
  return Math.min(1, most);
}

/**
 * The dBFS of a level of the meter (the inverse of level()'s mapping),
 * rounded to whole decibels; -Infinity at 0.
 * @param {number} value
 * @param {{ floor?: number }} [options]
 * @returns {number}
 */
export function decibels(value, options = {}) {
  const floor = Number.isFinite(options.floor) && options.floor < 0 ? options.floor : FLOOR_DB;
  const share = Math.min(1, Math.max(0, Number(value) || 0));
  if (share === 0) return -Infinity;
  return Math.round(floor + share * -floor) || 0;
}

const clamp = (value) => Math.min(1, Math.max(0, Number(value) || 0));

function meterController(el, start = {}) {
  const doc = el.ownerDocument;
  const view = doc.defaultView ?? globalThis;
  const track = el.querySelector('.ds-levelmeter__track') ?? el;
  const peakMark = el.querySelector('.ds-levelmeter__peak');
  const note = el.querySelector('.ds-levelmeter__note');
  const floor = Number.isFinite(start.floor) && start.floor < 0 ? start.floor : FLOOR_DB;
  const listeners = new Set();
  /** The level of LOUD_DB on this meter's scale: loud by a set() value without a sample peak. */
  const loudLevel = 1 - (LOUD_DB / floor);

  let target = 0;
  /** The sample peak of the last block or set(), or null when set() gave none. */
  let targetPeak = null;
  let shown = 0;
  let peakLevel = 0;
  let peakAt = 0;
  let loud = false;
  let quietSince = 0;
  let lastAria = -Infinity;
  let lastFrame = 0;
  let frame = 0;
  /** @type {AnalyserNode|null} */
  let analyser = null;
  /** @type {Float32Array|null} */
  let buffer = null;
  let destroyed = false;

  for (const name of ['aria-valuenow', 'aria-valuetext']) own(track, 'attrs', name);
  own(el, 'attrs', 'data-state');
  if (peakMark) {
    own(peakMark, 'attrs', 'hidden');
    peakMark.hidden = true;
  }

  const muted = () => track.getAttribute('aria-disabled') === 'true';

  const paint = (now) => {
    track.style.setProperty('--ds-levelmeter-level', String(Math.round(shown * 1000) / 1000));
    track.style.setProperty('--ds-levelmeter-peak', String(Math.round(peakLevel * 1000) / 1000));
    if (peakMark && peakMark.hidden !== !(peakLevel > 0)) peakMark.hidden = !(peakLevel > 0);
    if (now - lastAria >= motionDuration(el, '--ds-hold-status')) {
      lastAria = now;
      const value = String(Math.round(shown * 100));
      if (track.getAttribute('aria-valuenow') !== value) {
        track.setAttribute('aria-valuenow', value);
        const db = decibels(shown, { floor });
        track.setAttribute('aria-valuetext', t('levelmeterValue', { value: Number.isFinite(db) ? db : floor }));
      }
    }
  };

  const setLoud = (next) => {
    if (next === loud) return;
    loud = next;
    if (loud) el.setAttribute('data-state', 'loud');
    else el.removeAttribute('data-state');
    if (note) note.textContent = loud ? t('levelmeterLoud') : '';
    if (destroyed) return;
    const detail = { loud };
    emit(el, 'change', detail);
    listeners.forEach((fn) => fn(detail));
  };

  /** One step of the ballistics; true while something still moves. */
  const step = (now) => {
    const dt = lastFrame ? Math.max(0, now - lastFrame) : 0;
    lastFrame = now;
    if (analyser && buffer) {
      analyser.getFloatTimeDomainData(buffer);
      target = level(buffer, { floor });
      targetPeak = peak(buffer);
    }
    const value = muted() ? 0 : target;
    const fall = dt / Math.max(1, motionDuration(el, '--ds-dur-glide'));
    shown = value >= shown ? value : Math.max(value, shown - fall);
    if (shown >= peakLevel) {
      peakLevel = shown;
      peakAt = now;
    } else if (now - peakAt > motionDuration(el, '--ds-hold-status')) {
      peakLevel = Math.max(shown, peakLevel - fall);
    }
    // Loud at once; quiet again only after a hold, so the word does not flicker.
    const clipping = !muted() && (targetPeak === null ? value >= loudLevel : targetPeak >= LOUD_PEAK);
    if (clipping) {
      quietSince = 0;
      setLoud(true);
    } else if (loud) {
      quietSince ||= now;
      if (now - quietSince >= motionDuration(el, '--ds-hold-status')) setLoud(false);
    }
    paint(now);
    return Boolean(analyser) || shown !== value || peakLevel !== shown || loud;
  };

  const tick = (now) => {
    frame = 0;
    if (destroyed) return;
    if (step(now)) frame = view.requestAnimationFrame(tick);
    else lastFrame = 0;
  };

  const run = () => {
    if (destroyed || frame || typeof view.requestAnimationFrame !== 'function') return;
    frame = view.requestAnimationFrame(tick);
  };

  const controller = {
    get() { return { level: target, peak: peakLevel, loud }; },
    set(value, options = {}) {
      target = clamp(value);
      targetPeak = Number.isFinite(options?.peak) ? clamp(options.peak) : null;
      run();
    },
    listen(node) {
      analyser = node && typeof node.getFloatTimeDomainData === 'function' ? node : null;
      buffer = analyser ? new Float32Array(analyser.fftSize || 2048) : null;
      run();
      const mine = analyser;
      return () => {
        if (analyser !== mine) return;
        analyser = null;
        buffer = null;
        target = 0;
        targetPeak = null;
        run();
      };
    },
    on(type, fn) {
      if (type !== 'change') return () => {};
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    destroy() {
      destroyed = true;
      if (frame && typeof view.cancelAnimationFrame === 'function') view.cancelAnimationFrame(frame);
      frame = 0;
      analyser = null;
      listeners.clear();
      for (const name of ['aria-valuenow', 'aria-valuetext']) disown(track, 'attrs', name);
      disown(el, 'attrs', 'data-state');
      el.removeAttribute('data-state');
      if (peakMark) disown(peakMark, 'attrs', 'hidden');
      track.style.removeProperty('--ds-levelmeter-level');
      track.style.removeProperty('--ds-levelmeter-peak');
    },
  };
  if (start.analyser) controller.listen(start.analyser);
  return controller;
}

define('levelmeter', {
  attribute: 'data-ds-levelmeter',
  init(el) {
    return meterController(el);
  },
});

/**
 * A meter driven from the page: `analyser` (an AnalyserNode) is read every
 * frame; without it the page calls set(). `floor` is the dBFS of the empty
 * track (default -60). The same controller the attribute path makes, with
 * listen(analyser) besides get, set, on and destroy.
 * @param {Element} el
 * @param {{ analyser?: AnalyserNode|null, floor?: number }} [options]
 */
export function create(el, options = {}) {
  return meterController(el, options);
}
