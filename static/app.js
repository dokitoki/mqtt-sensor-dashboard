const $ = (id) => document.getElementById(id);

let model = { settings: {}, points: [], runtime: {} };
let saving = false;
let filterText = "";
let showHidden = false;

function appBase() {
  return window.location.pathname.startsWith("/sensors") ? "/sensors/" : "/";
}

function isSettingsView() {
  return window.location.pathname.replace(/\/+$/, "").endsWith("/settings");
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

function statusText(runtime) {
  const bits = [];
  if (!runtime.has_mqtt_library) bits.push("MQTT library missing");
  if (!runtime.has_credentials) bits.push("credentials missing");
  if (runtime.last_error) bits.push(runtime.last_error);
  return bits.join(" · ");
}

function ageText(seconds) {
  if (seconds == null || seconds < 0) return "";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m ago`;
}

function grouped(points) {
  const groups = new Map();
  let visible;
  if (isSettingsView()) {
    visible = points.filter((p) => {
      if (!showHidden && p.hidden) return false;
      if (!filterText) return true;
      const q = filterText.toLowerCase();
      return (
        p.topic.toLowerCase().includes(q) ||
        (p.name || "").toLowerCase().includes(q) ||
        (p.group || "").toLowerCase().includes(q)
      );
    });
  } else {
    visible = points.filter((p) => p.selected);
  }
  for (const point of visible) {
    const name = point.group || "Ungrouped";
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(point);
  }
  return [...groups.entries()];
}

function layoutTopics() {
  return model.points.map((point) => point.topic);
}

function moveTopic(topic, direction) {
  const index = model.points.findIndex((point) => point.topic === topic);
  const next = index + direction;
  if (index < 0 || next < 0 || next >= model.points.length) return;
  const copy = [...model.points];
  [copy[index], copy[next]] = [copy[next], copy[index]];
  model.points = copy;
  save({ layout: layoutTopics() });
  render();
}

async function save(payload) {
  saving = true;
  try {
    const response = await fetch(`${appBase()}api/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    model = await response.json();
    render();
  } finally {
    saving = false;
  }
}

async function deleteTopic(topic) {
  if (!confirm(`Remove "${topic}" from state?\n\nIt will reappear automatically if the broker publishes to this topic again.`)) return;
  saving = true;
  try {
    const response = await fetch(`${appBase()}api/points`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic }),
    });
    model = await response.json();
    render();
  } finally {
    saving = false;
  }
}

function savePoint(topic, form) {
  const staleRaw = form.elements.stale_after_seconds.value.trim();
  const changes = {
    name: form.elements.name.value.trim(),
    group: form.elements.group.value.trim() || "Ungrouped",
    stale_after_seconds: staleRaw ? Number(staleRaw) : null,
    selected: form.elements.selected.checked,
  };
  save({ points: { [topic]: changes } });
}

function saveField(topic, key, row) {
  const selected = row.querySelector("[data-field-selected]").checked;
  const name = row.querySelector("[data-field-name]").value.trim();
  const expr = (row.querySelector("[data-field-expr]")?.value || "").trim();
  const unit = (row.querySelector("[data-field-unit]")?.value || "").trim();
  const decimalsRaw = (row.querySelector("[data-field-decimals]")?.value || "").trim();
  const transform = (expr || unit || decimalsRaw) ? {
    expr: expr || null,
    unit: unit || null,
    decimals: decimalsRaw !== "" ? parseInt(decimalsRaw) : null,
  } : null;
  save({ points: { [topic]: { fields: { [key]: { selected, name, transform } } } } });
}

function applyTransform(rawValue, transform) {
  const unit = transform?.unit || "";
  if (!transform?.expr || rawValue == null || rawValue === "") {
    return { display: String(rawValue ?? ""), unit };
  }
  const num = parseFloat(rawValue);
  if (isNaN(num)) return { display: String(rawValue), unit };
  try {
    const result = new Function("x", `'use strict'; return (${transform.expr})`)(num);
    if (typeof result !== "number" || !isFinite(result)) return { display: String(rawValue), unit };
    const dec = transform.decimals != null ? parseInt(transform.decimals) : null;
    return { display: (!isNaN(dec) && dec != null) ? result.toFixed(dec) : String(result), unit };
  } catch {
    return { display: String(rawValue), unit };
  }
}

function saveTransform(topic, form) {
  const expr = form.elements.expr.value.trim();
  const unit = form.elements.unit.value.trim();
  const decimalsRaw = form.elements.decimals.value.trim();
  const transform = (expr || unit || decimalsRaw) ? {
    expr: expr || null,
    unit: unit || null,
    decimals: decimalsRaw !== "" ? parseInt(decimalsRaw) : null,
  } : null;
  save({ points: { [topic]: { transform } } });
}

function updateTransformPreview(form, rawValue) {
  const preview = form.querySelector(".transform-preview");
  if (!preview) return;
  const expr = form.elements.expr.value.trim();
  const unit = form.elements.unit.value.trim();
  const decimalsRaw = form.elements.decimals.value.trim();
  const { display, unit: u } = applyTransform(rawValue, {
    expr, unit, decimals: decimalsRaw !== "" ? parseInt(decimalsRaw) : null,
  });
  if (expr && display !== String(rawValue ?? "")) {
    preview.textContent = `${rawValue} → ${display}${u ? " " + u : ""}`;
  } else if (u) {
    preview.textContent = `${rawValue} ${u}`;
  } else {
    preview.textContent = "";
  }
}

function fieldEntries(point) {
  const values = point.field_values || {};
  const fields = point.fields || {};
  return Object.entries(values)
    .filter(([, value]) => ["string", "number", "boolean"].includes(typeof value) || value == null)
    .map(([key, value]) => ({
      key,
      value,
      name: fields[key]?.name || key.replace(/[_-]/g, " "),
      selected: Boolean(fields[key]?.selected),
      transform: fields[key]?.transform || null,
    }));
}

function renderFields(point) {
  return fieldEntries(point).slice(0, 14)
    .map((field) => `<div><dt>${escapeHtml(field.key)}</dt><dd>${escapeHtml(field.value)}</dd></div>`)
    .join("");
}

function renderFieldPicker(point) {
  const fields = fieldEntries(point);
  if (!fields.length) return "";
  return fields.map((field) => {
    const tx = field.transform || {};
    return `
    <div class="field-row" data-field-key="${escapeHtml(field.key)}">
      <label class="check">
        <input data-field-selected type="checkbox" ${field.selected ? "checked" : ""}>
        Dashboard
      </label>
      <label>
        Field name
        <input data-field-name value="${escapeHtml(field.name)}" autocomplete="off">
      </label>
      <code title="${escapeHtml(field.key)}">${escapeHtml(field.key)}</code>
      <strong data-raw-value>${escapeHtml(field.value)}</strong>
      <details class="field-transform-section"${tx.expr || tx.unit ? " open" : ""}>
        <summary class="field-transform-summary">Transform</summary>
        <div class="field-transform-form">
          <label>Formula <span class="hint">x = value</span>
            <input data-field-expr placeholder="x / 10" value="${escapeHtml(tx.expr || "")}" autocomplete="off" spellcheck="false">
          </label>
          <label>Unit
            <input data-field-unit placeholder="°C" value="${escapeHtml(tx.unit || "")}" autocomplete="off">
          </label>
          <label>Decimals
            <input data-field-decimals type="number" min="0" max="8" placeholder="auto" value="${tx.decimals != null ? tx.decimals : ""}">
          </label>
          <p class="transform-preview"></p>
        </div>
      </details>
    </div>
  `}).join("");
}

function renderCard(point) {
  const template = $("cardTemplate").content.cloneNode(true);
  const card = template.querySelector(".sensor-card");
  const form = template.querySelector(".editor");
  card.classList.toggle("stale", Boolean(point.stale));
  card.dataset.topic = point.topic;
  form.elements.name.value = point.name || "";
  form.elements.group.value = point.group || "";
  form.elements.stale_after_seconds.value = point.stale_after_seconds ?? "";
  form.elements.selected.checked = Boolean(point.selected);
  const ts = point.source_updated_at || point.updated_at;
  const ageEl = template.querySelector(".age");
  ageEl.textContent = point.stale ? `stale · ${ageText(point.age_seconds)}` : ageText(point.age_seconds);
  if (ts) {
    ageEl.dataset.ts = ts;
    ageEl.dataset.stale = point.stale ? "1" : "";
  }
  template.querySelector(".topic-label").textContent = point.topic;
  template.querySelector(".value").textContent = point.value ?? "";

  const tx = point.transform || {};
  const txForm = template.querySelector(".transform-form");
  txForm.elements.expr.value = tx.expr || "";
  txForm.elements.unit.value = tx.unit || "";
  txForm.elements.decimals.value = tx.decimals != null ? tx.decimals : "";
  if (tx.expr || tx.unit) template.querySelector(".transform-section").open = true;
  updateTransformPreview(txForm, point.value);
  txForm.querySelectorAll("input").forEach((input) => {
    input.addEventListener("input", () => updateTransformPreview(txForm, point.value));
    input.addEventListener("change", () => saveTransform(point.topic, txForm));
  });

  template.querySelector(".fields").innerHTML = renderFields(point);
  template.querySelector(".field-picker").innerHTML = renderFieldPicker(point);
  template.querySelector(".meta").innerHTML = [
    point.retained ? "<span>retained</span>" : "",
    Number.isFinite(point.qos) ? `<span>qos ${point.qos}</span>` : "",
    point.source_updated_at ? "<span>sensor time</span>" : "",
    point.hidden ? "<span>hidden</span>" : "",
  ].filter(Boolean).join("");
  template.querySelector(".move-up").addEventListener("click", () => moveTopic(point.topic, -1));
  template.querySelector(".move-down").addEventListener("click", () => moveTopic(point.topic, 1));
  template.querySelector(".delete-topic").addEventListener("click", () => deleteTopic(point.topic));
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    savePoint(point.topic, form);
  });
  form.querySelectorAll("input").forEach((input) => {
    input.addEventListener("change", () => savePoint(point.topic, form));
  });
  template.querySelectorAll(".field-row").forEach((row) => {
    const key = row.dataset.fieldKey;
    const rawValue = row.querySelector("[data-raw-value]")?.textContent || "";
    const preview = row.querySelector(".transform-preview");

    const refreshPreview = () => {
      if (!preview) return;
      const expr = (row.querySelector("[data-field-expr]")?.value || "").trim();
      const unit = (row.querySelector("[data-field-unit]")?.value || "").trim();
      const dec = row.querySelector("[data-field-decimals]")?.value.trim();
      const { display, unit: u } = applyTransform(rawValue, {
        expr, unit, decimals: dec ? parseInt(dec) : null,
      });
      if (expr && display !== String(rawValue ?? "")) {
        preview.textContent = `${rawValue} → ${display}${u ? " " + u : ""}`;
      } else if (u) {
        preview.textContent = `${rawValue} ${u}`;
      } else {
        preview.textContent = "";
      }
    };

    refreshPreview();
    row.querySelectorAll("input").forEach((input) => {
      input.addEventListener("change", () => saveField(point.topic, key, row));
      if (input.matches("[data-field-expr],[data-field-unit],[data-field-decimals]")) {
        input.addEventListener("input", refreshPreview);
      }
    });
  });
  return template;
}

function renderTile(name, value, stale, updatedAt) {
  const template = $("tileTemplate").content.cloneNode(true);
  const tile = template.querySelector(".dashboard-tile");
  tile.classList.toggle("stale", Boolean(stale));
  template.querySelector(".tile-name").textContent = name;
  template.querySelector(".tile-value").textContent = value ?? "";
  if (stale && updatedAt) {
    const ageEl = template.querySelector(".tile-age");
    ageEl.dataset.ts = updatedAt;
    ageEl.dataset.stale = "1";
    ageEl.textContent = `stale · ${ageText(Math.round((Date.now() - updatedAt) / 1000))}`;
  }
  return template;
}

function dashboardItems() {
  const items = [];
  for (const point of model.points) {
    const group = point.group || "Ungrouped";
    const updatedAt = point.source_updated_at || point.updated_at;
    if (point.selected) {
      const { display, unit } = applyTransform(point.value, point.transform);
      items.push({
        name: point.name || point.topic,
        value: unit ? `${display} ${unit}` : display,
        stale: point.stale,
        group,
        updatedAt,
      });
    }
    for (const field of fieldEntries(point)) {
      if (!field.selected) continue;
      const { display, unit } = applyTransform(field.value, field.transform);
      items.push({
        name: field.name || `${point.name || point.topic} ${field.key}`,
        value: unit ? `${display} ${unit}` : display,
        stale: point.stale,
        group,
        updatedAt,
      });
    }
  }
  return items;
}

function renderEmpty(message, detail) {
  $("empty").hidden = false;
  $("empty").querySelector("strong").textContent = message;
  $("empty").querySelector("span").innerHTML = detail;
}

function render() {
  const settingsView = isSettingsView();
  const items = dashboardItems();
  const runtime = model.runtime || {};
  const totalCount = model.points.length;
  const selectedCount = items.length;

  // Status bar with connection dot
  const connClass = runtime.connected ? "dot dot-ok" : "dot dot-err";
  const connLabel = runtime.connected ? "connected" : "not connected";
  const extra = statusText(runtime);
  $("status").innerHTML = `<span class="${connClass}"></span> ${connLabel}${extra ? " · " + escapeHtml(extra) : ""} · ${selectedCount} on dashboard · ${totalCount} topics`;

  $("dashboardLink").classList.toggle("active", !settingsView);
  $("settingsLink").classList.toggle("active", settingsView);
  $("settings").hidden = !settingsView;
  $("staleAfter").value = model.settings?.stale_after_seconds ?? "";
  $("filterBar").hidden = !settingsView;
  $("dashboard").hidden = settingsView;
  $("groups").hidden = !settingsView;
  $("empty").hidden = true;

  if (settingsView) {
    const filteredGroups = grouped(model.points);
    const visibleCount = filteredGroups.reduce((n, [, pts]) => n + pts.length, 0);
    const hiddenCount = model.points.filter((p) => p.hidden).length;

    const filterStatus = $("filterStatus");
    if (filterStatus) {
      if (filterText) {
        filterStatus.textContent = `${visibleCount} of ${totalCount} topics`;
      } else if (showHidden || hiddenCount === 0) {
        filterStatus.textContent = `${totalCount} topics`;
      } else {
        filterStatus.textContent = `${totalCount - hiddenCount} topics · ${hiddenCount} hidden`;
      }
    }

    const root = $("groups");
    root.innerHTML = "";

    if (!model.points.length) {
      renderEmpty("No MQTT data yet", "Fill <code>credentials/mqtt.json</code>. The server will subscribe and discover topics automatically.");
      return;
    }

    if (!visibleCount) {
      const msg = document.createElement("p");
      msg.className = "filter-empty";
      msg.textContent = filterText ? `No topics match "${filterText}"` : "No visible topics";
      root.appendChild(msg);
      return;
    }

    for (const [name, points] of filteredGroups) {
      const section = document.createElement("section");
      section.className = "group";
      section.innerHTML = `<header><h2>${escapeHtml(name)}</h2><span>${points.length} point${points.length === 1 ? "" : "s"}</span></header><div class="cards"></div>`;
      const cards = section.querySelector(".cards");
      for (const point of points) cards.appendChild(renderCard(point));
      root.appendChild(section);
    }
    return;
  }

  // Dashboard view
  const root = $("dashboard");
  root.innerHTML = "";

  if (!items.length) {
    if (!model.points.length) {
      renderEmpty("No MQTT data yet", "Fill <code>credentials/mqtt.json</code>. The server will subscribe and discover topics automatically.");
    } else {
      renderEmpty("No dashboard topics selected", `Open <a href="${appBase()}settings">settings</a> and tick Dashboard on the topics you want to display.`);
    }
    return;
  }

  const dashGroups = new Map();
  for (const item of items) {
    if (!dashGroups.has(item.group)) dashGroups.set(item.group, []);
    dashGroups.get(item.group).push(item);
  }

  const multiGroup = dashGroups.size > 1;
  for (const [groupName, groupItems] of dashGroups) {
    const section = document.createElement("section");
    section.className = "dash-section";
    if (multiGroup) {
      const h2 = document.createElement("h2");
      h2.className = "dash-group-name";
      h2.textContent = groupName;
      section.appendChild(h2);
    }
    const grid = document.createElement("div");
    grid.className = "tiles";
    for (const item of groupItems) {
      grid.appendChild(renderTile(item.name, item.value, item.stale, item.updatedAt));
    }
    section.appendChild(grid);
    root.appendChild(section);
  }
}

function tickAges() {
  const now = Date.now();
  document.querySelectorAll("[data-ts]").forEach((el) => {
    const ts = Number(el.dataset.ts);
    if (!ts) return;
    const seconds = Math.round((now - ts) / 1000);
    const text = ageText(seconds);
    el.textContent = el.dataset.stale ? `stale · ${text}` : text;
  });
}

$("settings").addEventListener("submit", (event) => {
  event.preventDefault();
  save({ settings: { stale_after_seconds: Number($("staleAfter").value) || 300 } });
});

$("filterInput").addEventListener("input", () => {
  filterText = $("filterInput").value;
  render();
});

$("showHiddenCheck").addEventListener("change", () => {
  showHidden = $("showHiddenCheck").checked;
  render();
});

function isEditingSettings() {
  const active = document.activeElement;
  const inputFocused = active &&
    (active.tagName === "INPUT" || active.tagName === "TEXTAREA") &&
    Boolean(active.closest("#groups, #filterBar"));
  const transformOpen = Boolean(
    document.querySelector("#groups .transform-section[open], #groups .field-transform-section[open]")
  );
  return inputFocused || transformOpen;
}

async function refresh() {
  if (saving) return;
  if (isEditingSettings()) return;
  try {
    const response = await fetch(`${appBase()}api/points`, { cache: "no-store" });
    model = await response.json();
    render();
  } catch (error) {
    $("status").textContent = `offline · ${error.message}`;
  }
}

refresh();
setInterval(refresh, 5000);
setInterval(tickAges, 1000);
