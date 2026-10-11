import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.1/index.js';

/**
 * Generates three outputs:
 *   reports/report.html  — Visual HTML report with per-transaction breakdown (open in browser)
 *   reports/summary.json — Raw JSON metrics (used by CDP portal)
 *   stdout               — Coloured text table (terminal)
 */
export const handleSummary = (data) => ({
  'reports/report.html': buildHtmlReport(data),
  'reports/summary.json': JSON.stringify(data, null, 2),
  stdout: textSummary(data, { indent: ' ', enableColors: true }),
});

// ── HTML report builder ────────────────────────────────────────────────────────

function ms(v) {
  return v == null ? '-' : Math.round(v) + ' ms';
}

function rate(v) {
  return v == null ? '-' : (v * 100).toFixed(2) + '%';
}

function buildHtmlReport(data) {
  var metrics = data.metrics || {};

  // Collect all http_req_duration sub-metrics (named transactions)
  var transactions = [];
  var keys = Object.keys(metrics);
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    if (key.indexOf('http_req_duration{name:') === 0) {
      var name = key.replace('http_req_duration{name:', '').replace('}', '');
      var m = metrics[key];
      var vals = m.values || {};
      // Check threshold pass/fail
      var thresholds = m.thresholds || {};
      var tKeys = Object.keys(thresholds);
      var passed = true;
      for (var t = 0; t < tKeys.length; t++) {
        if (!thresholds[tKeys[t]].ok) { passed = false; break; }
      }
      transactions.push({
        name: name,
        avg: vals.avg,
        min: vals.min,
        med: vals.med,
        p90: vals['p(90)'],
        p95: vals['p(95)'],
        p99: vals['p(99)'],
        max: vals.max,
        count: vals.count,
        passed: passed,
        hasThreshold: tKeys.length > 0,
      });
    }
  }

  // Overall metrics
  var dur = (metrics['http_req_duration'] || {}).values || {};
  var reqs = (metrics['http_reqs'] || {}).values || {};
  var failed = (metrics['http_req_failed'] || {}).values || {};
  var iters = (metrics['iterations'] || {}).values || {};
  var vusMax = (metrics['vus_max'] || {}).values || {};

  var overallPassed = true;
  var thresholdRows = '';
  for (var k = 0; k < keys.length; k++) {
    var mk = metrics[keys[k]];
    var tkk = Object.keys(mk.thresholds || {});
    for (var tt = 0; tt < tkk.length; tt++) {
      if (!mk.thresholds[tkk[tt]].ok) { overallPassed = false; }
      thresholdRows += '<tr class="' + (mk.thresholds[tkk[tt]].ok ? 'pass' : 'fail') + '">'
        + '<td>' + keys[k] + '</td>'
        + '<td>' + tkk[tt] + '</td>'
        + '<td>' + (mk.thresholds[tkk[tt]].ok ? '✓ PASS' : '✗ FAIL') + '</td>'
        + '</tr>';
    }
  }

  var txRows = '';
  for (var tx = 0; tx < transactions.length; tx++) {
    var t2 = transactions[tx];
    var rowClass = t2.hasThreshold ? (t2.passed ? 'pass' : 'fail') : '';
    txRows += '<tr class="' + rowClass + '">'
      + '<td>' + t2.name + '</td>'
      + '<td>' + (t2.count || '-') + '</td>'
      + '<td>' + ms(t2.avg) + '</td>'
      + '<td>' + ms(t2.min) + '</td>'
      + '<td>' + ms(t2.med) + '</td>'
      + '<td>' + ms(t2.p90) + '</td>'
      + '<td>' + ms(t2.p95) + '</td>'
      + '<td>' + ms(t2.p99) + '</td>'
      + '<td>' + ms(t2.max) + '</td>'
      + '<td>' + (t2.hasThreshold ? (t2.passed ? '✓' : '✗') : '') + '</td>'
      + '</tr>';
  }

  return '<!DOCTYPE html><html><head><meta charset="utf-8">'
    + '<title>k6 Performance Report</title>'
    + '<style>'
    + 'body{font-family:sans-serif;margin:2rem;color:#222}'
    + 'h1{color:#333}h2{margin-top:2rem;color:#555;border-bottom:1px solid #ddd;padding-bottom:.3rem}'
    + '.badge{display:inline-block;padding:.3rem .8rem;border-radius:4px;font-weight:bold;font-size:1.1rem}'
    + '.badge.pass{background:#d4edda;color:#155724}.badge.fail{background:#f8d7da;color:#721c24}'
    + 'table{border-collapse:collapse;width:100%;margin-top:1rem;font-size:.9rem}'
    + 'th{background:#444;color:#fff;padding:.5rem .8rem;text-align:left}'
    + 'td{padding:.4rem .8rem;border-bottom:1px solid #eee}'
    + 'tr.pass td:last-child{color:#155724;font-weight:bold}'
    + 'tr.fail{background:#fff5f5}tr.fail td:last-child{color:#721c24;font-weight:bold}'
    + '.stat-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:1rem;margin-top:1rem}'
    + '.stat{background:#f8f9fa;border:1px solid #dee2e6;border-radius:6px;padding:.8rem 1rem}'
    + '.stat .val{font-size:1.5rem;font-weight:bold;color:#0056b3}'
    + '.stat .lbl{font-size:.8rem;color:#666;margin-top:.2rem}'
    + '</style></head><body>'
    + '<h1>k6 Performance Report</h1>'
    + '<span class="badge ' + (overallPassed ? 'pass' : 'fail') + '">'
    + (overallPassed ? '✓ All thresholds passed' : '✗ Some thresholds failed') + '</span>'

    + '<h2>Overall</h2>'
    + '<div class="stat-grid">'
    + '<div class="stat"><div class="val">' + (iters.count || '-') + '</div><div class="lbl">Iterations</div></div>'
    + '<div class="stat"><div class="val">' + (reqs.count || '-') + '</div><div class="lbl">HTTP Requests</div></div>'
    + '<div class="stat"><div class="val">' + rate(failed.rate) + '</div><div class="lbl">Error Rate</div></div>'
    + '<div class="stat"><div class="val">' + (vusMax.max || '-') + '</div><div class="lbl">Peak VUs</div></div>'
    + '<div class="stat"><div class="val">' + ms(dur.avg) + '</div><div class="lbl">Avg Response</div></div>'
    + '<div class="stat"><div class="val">' + ms(dur['p(95)']) + '</div><div class="lbl">p95 Response</div></div>'
    + '<div class="stat"><div class="val">' + ms(dur['p(99)']) + '</div><div class="lbl">p99 Response</div></div>'
    + '<div class="stat"><div class="val">' + ms(dur.max) + '</div><div class="lbl">Max Response</div></div>'
    + '</div>'

    + '<h2>Transactions</h2>'
    + '<table><thead><tr>'
    + '<th>Transaction</th><th>Count</th><th>Avg</th><th>Min</th><th>Med</th>'
    + '<th>p90</th><th>p95</th><th>p99</th><th>Max</th><th>Threshold</th>'
    + '</tr></thead><tbody>'
    + (txRows || '<tr><td colspan="10">No named transactions found — add per-transaction thresholds to options.</td></tr>')
    + '</tbody></table>'

    + '<h2>All Thresholds</h2>'
    + '<table><thead><tr><th>Metric</th><th>Condition</th><th>Result</th></tr></thead><tbody>'
    + (thresholdRows || '<tr><td colspan="3">No thresholds defined.</td></tr>')
    + '</tbody></table>'

    + '</body></html>';
}
