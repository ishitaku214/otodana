"use strict";

class PlaybackQueue {
  upcoming = [];
  previous = [];
  history = [];
  scope = [];
  shuffled = false;
  repeat = false;

  start(tracks, track) {
    this.scope = tracks.slice();
    const index = tracks.indexOf(track);
    this.previous = tracks.slice(0, index);
    this.upcoming = tracks.slice(index + 1);
    if (this.shuffled) this.shuffleUpcoming();
  }

  updateScope(tracks) {
    this.scope = tracks.slice();
    const available = new Set(tracks);
    this.upcoming = this.upcoming.filter((track) => available.has(track));
    this.previous = this.previous.filter((track) => available.has(track));
  }

  get hasNext() {
    return this.upcoming.length > 0 || (this.repeat && this.scope.length > 0);
  }

  shuffleUpcoming() {
    for (let index = this.upcoming.length - 1; index > 0; index--) {
      const other = Math.floor(Math.random() * (index + 1));
      [this.upcoming[index], this.upcoming[other]] = [this.upcoming[other], this.upcoming[index]];
    }
  }

  toggleShuffle() {
    this.shuffled = !this.shuffled;
    if (this.shuffled) {
      this.shuffleUpcoming();
    } else {
      const originalOrder = new Map(this.scope.map((track, index) => [track, index]));
      this.upcoming.sort((first, second) => originalOrder.get(first) - originalOrder.get(second));
    }
  }

  append(added) {
    this.scope.push(...added);
    for (const track of added) {
      const index = this.shuffled ? Math.floor(Math.random() * (this.upcoming.length + 1)) : this.upcoming.length;
      this.upcoming.splice(index, 0, track);
    }
  }

  forward(current, track) {
    if (!track && !this.upcoming.length && this.repeat) {
      this.upcoming = this.scope.slice();
      if (this.shuffled) {
        this.shuffleUpcoming();
        if (this.upcoming.length > 1 && this.upcoming[0] === current) {
          const other = 1 + Math.floor(Math.random() * (this.upcoming.length - 1));
          [this.upcoming[0], this.upcoming[other]] = [this.upcoming[other], this.upcoming[0]];
        }
      }
    }
    track ??= this.upcoming[0];
    const index = this.upcoming.indexOf(track);
    if (index < 0) return null;
    this.upcoming.splice(0, index + 1);
    this.previous.push(current);
    if (this.previous.length > Math.max(100, this.scope.length)) this.previous.shift();
    return track;
  }

  back(current) {
    const track = this.previous.pop();
    if (!track) return null;
    this.upcoming.unshift(current);
    return track;
  }

  record(track) {
    this.history.push(track);
    if (this.history.length > 100) this.history.shift();
  }

  reorder(track, to) {
    const index = this.upcoming.indexOf(track);
    if (index < 0 || index === to || to < 0 || to >= this.upcoming.length) return;
    this.upcoming.splice(index, 1);
    this.upcoming.splice(to, 0, track);
  }

  skip(track) {
    const index = this.upcoming.indexOf(track);
    if (index >= 0) this.upcoming.splice(index, 1);
  }

  remove(track, wasPlaying) {
    this.history = this.history.filter((entry) => entry !== track);
    this.scope = this.scope.filter((entry) => entry !== track);
    if (wasPlaying) {
      this.scope = [];
      this.upcoming = [];
      this.previous = [];
    } else {
      this.skip(track);
      this.previous = this.previous.filter((entry) => entry !== track);
    }
  }
}

function bindQueueGestures(list, scrollArea, actions, reducedMotion) {
  const canSwipe = Boolean(actions.remove);
  let drag = null;
  let revealed = null;
  let suppressClick = false;
  let scrollFrame = 0;

  function reveal(row) {
    if (revealed && revealed !== row) {
      delete revealed.dataset.revealed;
      revealed.querySelector(".queue-remove").hidden = true;
    }
    revealed = row;
    if (row) {
      row.dataset.revealed = "";
      row.querySelector(".queue-remove").hidden = false;
    }
  }

  function clearGesture() {
    if (!drag) return;
    cancelAnimationFrame(scrollFrame);
    scrollFrame = 0;
    for (const row of drag.rows) {
      delete row.dataset.gesture;
      row.style.removeProperty("--queue-shift");
    }
    if (canSwipe && drag.row !== revealed) drag.row.querySelector(".queue-remove").hidden = true;
    actions.previewDrop?.(null);
    drag = null;
  }

  function paintReorder(event) {
    const { row } = drag;
    const offset = event.clientY - drag.y + scrollArea.scrollTop - drag.scroll;
    actions.previewDrop?.(event);
    drag.target = Math.max(0, Math.min(drag.rows.length - 1, drag.index + Math.round(offset / drag.height)));
    row.style.setProperty("--queue-shift", offset + "px");
    for (const [index, neighbor] of drag.rows.entries()) {
      if (neighbor === row) continue;
      const shift = index > drag.index && index <= drag.target ? -drag.height :
        index < drag.index && index >= drag.target ? drag.height : 0;
      neighbor.style.setProperty("--queue-shift", shift + "px");
    }
  }

  function scrollWhileDragging() {
    scrollFrame = 0;
    if (drag?.mode !== "reorder") return;
    const before = scrollArea.scrollTop;
    scrollArea.scrollTop += actions.scrollDrag(drag.pointer);
    if (scrollArea.scrollTop === before) return;
    paintReorder(drag.pointer);
    scrollFrame = requestAnimationFrame(scrollWhileDragging);
  }

  function positions() {
    return new Map(Array.from(list.children, (row) => [row.track, row.getBoundingClientRect().top]));
  }

  function animateFrom(before) {
    if (reducedMotion.matches) return;
    for (const row of list.children) {
      const shift = before.get(row.track) - row.getBoundingClientRect().top;
      if (Number.isFinite(shift) && Math.abs(shift) > 1) {
        row.animate([{ transform: "translateY(" + shift + "px)" }, { transform: "translateY(0)" }],
          { duration: 230, easing: "cubic-bezier(.22, .8, .24, 1)" });
      }
    }
  }

  list.addEventListener("pointerdown", (event) => {
    if (!event.isPrimary || event.button !== 0) return;
    suppressClick = false;
    const row = event.target.closest(".queue-row");
    if (!row || event.target.closest(".queue-remove")) return;
    const handle = Boolean(event.target.closest(".queue-handle"));
    if (!canSwipe && !handle) return;
    if (revealed && revealed !== row) reveal(null);
    const rows = Array.from(list.children);
    const index = rows.indexOf(row);
    drag = {
      id: event.pointerId, x: event.clientX, y: event.clientY,
      row, rows, index, target: index, handle, mode: "",
      height: row.offsetHeight, scroll: scrollArea.scrollTop,
    };
  });

  list.addEventListener("pointermove", (event) => {
    if (event.pointerId !== drag?.id) return;
    const x = event.clientX - drag.x;
    const y = event.clientY - drag.y;
    if (!drag.mode && Math.max(Math.abs(x), Math.abs(y)) < 9) return;
    if (!drag.mode) {
      if (!drag.handle && (Math.abs(y) > Math.abs(x) || (x > 0 && drag.row !== revealed))) {
        clearGesture();
        return;
      }
      list.setPointerCapture(event.pointerId);
      drag.mode = !canSwipe || (drag.handle && Math.abs(y) >= Math.abs(x)) ? "reorder" : "swipe";
    }
    if (canSwipe && drag.mode === "reorder" && x < -60) {
      for (const row of drag.rows) row.style.removeProperty("--queue-shift");
      drag.mode = "swipe";
    }
    const row = drag.row;
    row.dataset.gesture = drag.mode;
    if (drag.mode === "swipe") {
      const start = row === revealed ? -72 : 0;
      drag.distance = Math.min(0, Math.max(-row.offsetWidth, start + x));
      row.querySelector(".queue-remove").hidden = false;
      row.style.setProperty("--queue-shift", drag.distance + "px");
      return;
    }
    paintReorder(event);
    if (actions.scrollDrag) {
      drag.pointer = event;
      if (!scrollFrame) scrollFrame = requestAnimationFrame(scrollWhileDragging);
    }
  });

  function endGesture(event) {
    // Touch starts with implicit capture on the button. Transferring it to
    // the list can emit a bubbling lostpointercapture before pointerup.
    if (event.type === "lostpointercapture" && event.target !== list) return;
    if (event.pointerId !== drag?.id) return;
    const { row, mode, target, distance } = drag;
    const before = positions();
    const finished = event.type === "pointerup" && Boolean(mode);
    if (finished && mode === "swipe" && distance > -112 && distance <= -33) reveal(row);
    else if (finished) reveal(null);
    clearGesture();
    if (!finished) return;
    suppressClick = true;
    if (mode === "reorder") {
      if (!actions.drop?.(row.track, event)) actions.reorder(row.track, target);
    }
    else if (distance <= -112) actions.remove(row.track);
    animateFrom(before);
  }
  for (const event of ["pointerup", "pointercancel", "lostpointercapture"]) {
    list.addEventListener(event, endGesture);
  }
  list.addEventListener("click", (event) => {
    if (!suppressClick || event.detail === 0) return;
    suppressClick = false;
    event.stopImmediatePropagation();
    event.preventDefault();
  }, true);

  list.addEventListener("keydown", (event) => {
    if (!event.target.closest(".queue-handle")) return;
    const row = event.target.closest(".queue-row");
    const index = Array.from(list.children).indexOf(row);
    const removes = canSwipe && ["Delete", "Backspace"].includes(event.key);
    if (!removes && !["ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    const before = positions();
    const target = index + (event.key === "ArrowUp" ? -1 : 1);
    if (removes) {
      actions.remove(row.track);
      list.children[Math.min(index, list.children.length - 1)]?.querySelector(".queue-handle").focus();
    } else if (target >= 0 && target < list.children.length) {
      actions.reorder(row.track, target);
      list.children[target]?.querySelector(".queue-handle").focus();
    }
    animateFrom(before);
  });

  return () => {
    reveal(null);
    clearGesture();
  };
}
