/**
 * Vercel Serverless Function — 上海全市履约看板数据中转
 *
 * 职责：
 *   1. 接收 iOS 快捷指令 POST 过来的牵牛花原始数据（stores）
 *   2. 聚合成 city_monitor / district_monitor / store_monitor 三张表的格式
 *   3. DELETE + INSERT 到 Supabase
 *
 * 环境变量（在 Vercel Dashboard 里配置）：
 *   SUPABASE_URL      — 数据库地址
 *   SUPABASE_ANON_KEY — 匿名 Key
 *   WORKER_SECRET     — 简单鉴权 token
 */

// ── 工具函数 ──────────────────────────────────────────────────────────

function safeFloat(v, def = 0.0) {
  if (v === null || v === undefined || v === "--") return def;
  const n = parseFloat(v);
  return isNaN(n) ? def : n;
}

function cleanName(name) {
  return (name || "")
    .replace("歪马送酒（", "")
    .replace("）", "")
    .replace("歪马送酒", "")
    .trim();
}

// ── 数据聚合 ──────────────────────────────────────────────────────────

function buildStoreRows(stores) {
  const rows = stores.map((s) => {
    const emp = s.workedEmployeeNum || 0;
    const rider = s.fulfillRiderNum || 0;
    const scheduleRate = emp > 0 ? Math.round((rider / emp) * 10000) / 100 : 0;
    return {
      store_id: String(s.storeId || ""),
      store_name: cleanName(s.storeName),
      city: s.upTwoLevelDepartmentName || "",
      district_name: s.upOneLevelDepartmentName || "",
      valid_order: s.validOrder || 0,
      rider_worked: rider,
      schedule_actual: emp,
      schedule_rate: scheduleRate,
      timeout_order_cnt: s.etaOvertimeOrdNumV2 || 0,
      serious_timeout_order_cnt: s.seriousTimeoutOrder || 0,
      rate_15min_val: safeFloat(s.deliveredRateIn15Min),
      rate_25min_val: safeFloat(s.deliveredRateIn25Min),
      eta_ontime_val: safeFloat(s.etaOntimeRatioV2),
      serious_timeout_val: safeFloat(s.etaBadOvertimeRatioV2),
      p90_duration_val: safeFloat(s.ninetiethFulfillDuration),
      avg_rider_load: safeFloat(s.avgRiderLoad),
      alert_level: "",
      alert_reasons: "",
    };
  });
  rows.sort((a, b) => b.valid_order - a.valid_order);
  return rows;
}

function buildDistrictRows(stores) {
  const distMap = {};
  for (const s of stores) {
    const dist = s.upOneLevelDepartmentName || "未知";
    if (!distMap[dist]) {
      distMap[dist] = {
        city: s.upTwoLevelDepartmentName || "未知",
        valid_order: 0, rider_worked: 0, store_cnt: 0, schedule_actual: 0,
        timeout_order_cnt: 0, serious_timeout_order_cnt: 0,
        rate_15min_sum: 0, rate_25min_sum: 0, eta_ontime_sum: 0,
        serious_timeout_val_sum: 0, p90_sum: 0, avg_load_sum: 0,
      };
    }
    const d = distMap[dist];
    d.valid_order               += s.validOrder || 0;
    d.rider_worked              += s.fulfillRiderNum || 0;
    d.store_cnt                 += 1;
    d.schedule_actual           += s.workedEmployeeNum || 0;
    d.timeout_order_cnt         += s.etaOvertimeOrdNumV2 || 0;
    d.serious_timeout_order_cnt += s.seriousTimeoutOrder || 0;
    d.rate_15min_sum            += safeFloat(s.deliveredRateIn15Min);
    d.rate_25min_sum            += safeFloat(s.deliveredRateIn25Min);
    d.eta_ontime_sum            += safeFloat(s.etaOntimeRatioV2);
    d.serious_timeout_val_sum   += safeFloat(s.etaBadOvertimeRatioV2);
    d.p90_sum                   += safeFloat(s.ninetiethFulfillDuration);
    d.avg_load_sum              += safeFloat(s.avgRiderLoad);
  }

  const rows = Object.entries(distMap).map(([name, d]) => {
    const n = d.store_cnt || 1;
    const emp = d.schedule_actual;
    const rider = d.rider_worked;
    const scheduleRate = emp > 0 ? Math.round((rider / emp) * 10000) / 100 : 0;
    return {
      district_id: name,
      district_name: name,
      city: name,
      valid_order: d.valid_order,
      rider_worked: rider,
      store_cnt: d.store_cnt,
      schedule_actual: emp,
      schedule_rate: scheduleRate,
      timeout_order_cnt: d.timeout_order_cnt,
      serious_timeout_order_cnt: d.serious_timeout_order_cnt,
      rate_15min_val: Math.round(d.rate_15min_sum / n * 100) / 100,
      rate_25min_val: Math.round(d.rate_25min_sum / n * 100) / 100,
      eta_ontime_val: Math.round(d.eta_ontime_sum / n * 100) / 100,
      serious_timeout_val: Math.round(d.serious_timeout_val_sum / n * 100) / 100,
      p90_duration_val: Math.round(d.p90_sum / n * 100) / 100,
      avg_rider_load: Math.round(d.avg_load_sum / n * 100) / 100,
      alert_level: "",
      alert_reasons: "",
    };
  });
  rows.sort((a, b) => b.valid_order - a.valid_order);
  return rows;
}

function buildCityRows(stores) {
  const cityMap = {};
  for (const s of stores) {
    const city = s.upTwoLevelDepartmentName || "未知";
    if (!cityMap[city]) {
      cityMap[city] = {
        rider_worked: 0, store_cnt: 0, schedule_actual: 0,
        timeout_order_cnt: 0, serious_timeout_order_cnt: 0,
        rate_15min_sum: 0, eta_ontime_sum: 0,
        serious_timeout_val_sum: 0, p90_sum: 0, avg_load_sum: 0,
      };
    }
    const c = cityMap[city];
    c.rider_worked              += s.fulfillRiderNum || 0;
    c.store_cnt                 += 1;
    c.schedule_actual           += s.workedEmployeeNum || 0;
    c.timeout_order_cnt         += s.etaOvertimeOrdNumV2 || 0;
    c.serious_timeout_order_cnt += s.seriousTimeoutOrder || 0;
    c.rate_15min_sum            += safeFloat(s.deliveredRateIn15Min);
    c.eta_ontime_sum            += safeFloat(s.etaOntimeRatioV2);
    c.serious_timeout_val_sum   += safeFloat(s.etaBadOvertimeRatioV2);
    c.p90_sum                   += safeFloat(s.ninetiethFulfillDuration);
    c.avg_load_sum              += safeFloat(s.avgRiderLoad);
  }

  const rows = Object.entries(cityMap).map(([city, c]) => {
    const n = c.store_cnt || 1;
    return {
      city,
      rider_worked: c.rider_worked,
      store_cnt: c.store_cnt,
      schedule_actual: c.schedule_actual,
      timeout_order_cnt: c.timeout_order_cnt,
      serious_timeout_order_cnt: c.serious_timeout_order_cnt,
      rate_15min_val: Math.round(c.rate_15min_sum / n * 100) / 100,
      eta_ontime_val: Math.round(c.eta_ontime_sum / n * 100) / 100,
      eta_ontime: String(Math.round(c.eta_ontime_sum / n * 100) / 100),
      serious_timeout_val: Math.round(c.serious_timeout_val_sum / n * 100) / 100,
      p90_duration_val: Math.round(c.p90_sum / n * 100) / 100,
      avg_rider_load: Math.round(c.avg_load_sum / n * 100) / 100,
      weather_icon: "",
    };
  });
  rows.sort((a, b) => b.store_cnt - a.store_cnt);
  return rows;
}

// ── Supabase 操作 ─────────────────────────────────────────────────────

async function sbDeleteAll(url, key, table) {
  const r = await fetch(`${url}/rest/v1/${table}?id=gte.0`, {
    method: "DELETE",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
  });
  if (!r.ok) throw new Error(`DELETE ${table} failed: ${r.status}`);
}

async function sbInsert(url, key, table, rows) {
  if (!rows.length) return;
  const r = await fetch(`${url}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(rows),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`INSERT ${table} failed: ${r.status} ${text.slice(0, 200)}`);
  }
}

// ── Vercel Handler ────────────────────────────────────────────────────

export default async function handler(req, res) {
  // 只接受 POST
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  // 简单鉴权
  const secret = req.headers["x-worker-secret"];
  if (process.env.WORKER_SECRET && secret !== process.env.WORKER_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { stores } = req.body || {};
  if (!Array.isArray(stores) || stores.length === 0) {
    return res.status(400).json({ error: "stores array is required" });
  }

  // 聚合数据
  const storeRows    = buildStoreRows(stores);
  const districtRows = buildDistrictRows(stores);
  const cityRows     = buildCityRows(stores);

  const SUPABASE_URL      = process.env.SUPABASE_URL;
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

  try {
    // 清空三张表
    await Promise.all([
      sbDeleteAll(SUPABASE_URL, SUPABASE_ANON_KEY, "city_monitor"),
      sbDeleteAll(SUPABASE_URL, SUPABASE_ANON_KEY, "district_monitor"),
      sbDeleteAll(SUPABASE_URL, SUPABASE_ANON_KEY, "store_monitor"),
    ]);

    // 写入三张表
    await Promise.all([
      sbInsert(SUPABASE_URL, SUPABASE_ANON_KEY, "city_monitor",     cityRows),
      sbInsert(SUPABASE_URL, SUPABASE_ANON_KEY, "district_monitor", districtRows),
      sbInsert(SUPABASE_URL, SUPABASE_ANON_KEY, "store_monitor",    storeRows),
    ]);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  return res.status(200).json({
    ok: true,
    city: cityRows.length,
    district: districtRows.length,
    store: storeRows.length,
    updated_at: new Date().toISOString(),
  });
}
