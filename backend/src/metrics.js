const counters = new Map();

function metricKey(name, labels = {}) {
  const parts = Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}="${value}"`);
  return parts.length ? `${name}{${parts.join(",")}}` : name;
}

function bump(name, labels = {}) {
  const key = metricKey(name, labels);
  counters.set(key, (counters.get(key) || 0) + 1);
}

export function metricsMiddleware(req, res, next) {
  const finish = res.end.bind(res);

  res.end = (...args) => {
    try {
      bump("http_requests_total", {
        method: req.method,
        route: req.route?.path || req.path || "unknown",
        status: String(res.statusCode),
      });
    } catch {}
    return finish(...args);
  };

  next();
}

export function metricsHandler(_req, res) {
  const lines = [
    "# HELP http_requests_total Total HTTP requests",
    "# TYPE http_requests_total counter",
    ...[...counters.entries()].map(([key, value]) => `${key} ${value}`),
    "# HELP process_resident_memory_bytes Resident set size",
    "# TYPE process_resident_memory_bytes gauge",
    `process_resident_memory_bytes ${process.memoryUsage().rss}`,
    "# HELP process_uptime_seconds Process uptime",
    "# TYPE process_uptime_seconds gauge",
    `process_uptime_seconds ${process.uptime()}`,
  ];

  res.set("Content-Type", "text/plain; version=0.0.4");
  res.send(lines.join("\n") + "\n");
}
