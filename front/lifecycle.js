// Resources owned by one mount. The host's channel/onUp callbacks keep their
// existing disposed guards: the host API does not promise an unsubscribe handle.
export function createLifecycle(view) {
  let closed = false;
  const listeners = new Set(), timeouts = new Set(), intervals = new Set(), observers = new Set();
  function on(target, type, fn, opts) {
    if (closed) return;
    // Removal depends only on capture; do not retain a mutable options object.
    const capture = typeof opts === "boolean" ? opts : Boolean(opts?.capture);
    target.addEventListener(type, fn, opts);
    listeners.add({target, type, fn, capture});
  }
  function timeout(fn, delay) {
    if (closed) return null;
    const id = view.setTimeout(() => {
      timeouts.delete(id);
      if (!closed) fn();
    }, delay);
    timeouts.add(id);
    return id;
  }
  function clearTimeout(id) {
    view.clearTimeout(id);
    timeouts.delete(id);
  }
  function interval(fn, delay) {
    if (closed) return null;
    const id = view.setInterval(() => { if (!closed) fn(); }, delay);
    intervals.add(id);
    return id;
  }
  function clearInterval(id) {
    view.clearInterval(id);
    intervals.delete(id);
  }
  function observer(value) {
    if (closed) value.disconnect();
    else observers.add(value);
    return value;
  }
  function dispose() {
    if (closed) return;
    closed = true;
    for (const {target, type, fn, capture} of listeners) target.removeEventListener(type, fn, capture);
    for (const id of timeouts) view.clearTimeout(id);
    for (const id of intervals) view.clearInterval(id);
    for (const value of observers) value.disconnect();
    listeners.clear();
    timeouts.clear();
    intervals.clear();
    observers.clear();
  }
  return {on, timeout, clearTimeout, interval, clearInterval, observer, dispose};
}
