/**
 * 首屏插屏的兜底逻辑（不打包进主 bundle，独立小脚本，CSP 允许 'self'）
 * ===========================================================================
 * 线上验收报告 BUG-4 / 验收清单第 6 条：「冷启动首屏卡 Application loading，
 * 插页无超时重试」。
 * index.html 里的 #splash 只是静态画面，真正的兜底在这里：
 *   · 每 250ms 轮询一次，主应用挂载（#app 有子节点）后立刻移除插屏；
 *   · 8 秒还没挂载 → 换成「正在唤醒服务」文案 + 秒表；
 *   · 25 秒还没挂载 → 显示「仍然加载不出来？」+ 重试按钮 + 原始页面链接，
 *     用户不必只能干等或刷新猜原因。
 * 脚本失败（例如被网络中断）时页面仍有静态插屏，不会白屏。
 */
(function splashGuard() {
  var START = Date.now();
  var SLOW_AT = 8000;
  var FAIL_AT = 25000;
  var timer = null;
  var slowShown = false;
  var failShown = false;

  function byId(id) {
    return document.getElementById(id);
  }

  function remove() {
    var el = byId('splash');
    if (!el) return true;
    el.classList.add('splash-hide');
    setTimeout(function () {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, 400);
    return true;
  }

  function mounted() {
    var app = byId('app');
    return !!(app && app.children.length > 0);
  }

  function setText(node, text) {
    if (node) node.textContent = text;
  }

  function showSlow() {
    if (slowShown) return;
    slowShown = true;
    var hint = byId('splash-hint');
    if (hint) {
      hint.innerHTML =
        '正在唤醒后端服务（免费实例冷启动约 20~30 秒）…<br />已等待 <b id="splash-sec">0</b> 秒，请勿关闭页面';
    }
  }

  function showFail() {
    if (failShown) return;
    failShown = true;
    var tip = byId('splash-tip');
    if (!tip) return;
    tip.innerHTML =
      '<div style="margin-bottom:8px;color:#b45309">加载超过 25 秒，可能是网络中断或服务正在重启。</div>' +
      '<button id="splash-retry" type="button" style="border:0;border-radius:10px;padding:9px 20px;' +
      'font-size:14px;font-weight:600;color:#fff;background:linear-gradient(90deg,#22c55e,#3b82f6);cursor:pointer">重试加载</button> ' +
      '<a href="./" style="margin-left:10px;font-size:13px;color:#3b82f6;text-decoration:none">重新打开首页</a>';
    var btn = byId('splash-retry');
    if (btn) btn.addEventListener('click', function () {
      btn.disabled = true;
      btn.textContent = '正在重试…';
      location.reload();
    });
  }

  function tick() {
    if (mounted()) {
      if (timer) clearInterval(timer);
      remove();
      return;
    }
    var elapsed = Date.now() - START;
    if (elapsed >= SLOW_AT) showSlow();
    if (elapsed >= FAIL_AT) showFail();
    var sec = byId('splash-sec');
    if (sec) setText(sec, String(Math.floor(elapsed / 1000)));
  }

  function boot() {
    if (!byId('splash')) return; // 已经挂载并移除
    timer = setInterval(tick, 250);
    tick();
    // 主应用挂载后 Vue 会替换 #app 的子节点，这里额外监听一次 DOM 变化，响应更快
    if (window.MutationObserver) {
      var mo = new MutationObserver(function () {
        if (mounted()) {
          mo.disconnect();
          if (timer) clearInterval(timer);
          remove();
        }
      });
      var app = byId('app');
      if (app) mo.observe(app, { childList: true });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
