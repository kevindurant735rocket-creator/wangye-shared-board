/**
 * 登录页前端逻辑
 *  - 首次加载自动拉取一次验证码
 *  - 点击验证码图片刷新
 *  - 提交：校验 -> POST /api/auth/login -> 成功后跳 /（cookie 已由后端设置）
 *  - 失败：清空密码并刷新验证码
 */
(function () {
  'use strict';
  var form = document.getElementById('loginForm');
  var usernameEl = document.getElementById('username');
  var passwordEl = document.getElementById('password');
  var captchaInput = document.getElementById('captchaCode');
  var captchaBox = document.getElementById('refreshCaptcha');
  var errorEl = document.getElementById('errorMsg');
  var submitBtn = document.getElementById('submitBtn');

  var currentToken = null;

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.hidden = !msg;
  }

  function setLoading(loading) {
    submitBtn.disabled = !!loading;
    submitBtn.textContent = loading ? '登录中…' : '登录';
  }

  function fetchCaptcha() {
    captchaBox.innerHTML = '<span class="captcha-loading">加载中…</span>';
    return fetch('/api/auth/captcha', { method: 'GET', credentials: 'same-origin' })
      .then(function (res) {
        if (!res.ok) throw new Error('captcha fetch failed: ' + res.status);
        currentToken = res.headers.get('X-Token') || res.headers.get('x-token');
        return res.text();
      })
      .then(function (svg) {
        captchaBox.innerHTML = svg;
        // 让 svg 撑满按钮
        var svg = captchaBox.querySelector('svg');
        if (svg) {
          svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
          svg.style.width = '100%';
          svg.style.height = '100%';
        }
      })
      .catch(function (err) {
        captchaBox.innerHTML = '<span class="captcha-loading">加载失败</span>';
        showError('验证码加载失败，请重试');
        console.error(err);
      });
  }

  captchaBox.addEventListener('click', function () {
    fetchCaptcha();
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    showError('');

    var username = usernameEl.value.trim();
    var password = passwordEl.value;
    var captchaCode = captchaInput.value.trim();

    if (!username) return showError('请输入用户名');
    if (!password) return showError('请输入密码');
    if (!captchaCode) return showError('请输入验证码');
    if (!currentToken) {
      showError('验证码未就绪，请刷新');
      fetchCaptcha();
      return;
    }

    setLoading(true);
    fetch('/api/auth/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: username,
        password: password,
        captchaToken: currentToken,
        captchaCode: captchaCode,
      }),
    })
      .then(function (res) {
        return res.json().then(function (data) {
          return { ok: res.ok, status: res.status, data: data };
        });
      })
      .then(function (r) {
        if (r.ok) {
          // 跳到主页（cookie 已设）
          window.location.href = '/';
          return;
        }
        var msg = (r.data && r.data.error) ? r.data.error : ('登录失败 (' + r.status + ')');
        showError(msg);
        // 刷新验证码 + 清空密码
        passwordEl.value = '';
        captchaInput.value = '';
        fetchCaptcha();
      })
      .catch(function (err) {
        showError('网络错误：' + (err && err.message ? err.message : err));
        fetchCaptcha();
      })
      .finally(function () {
        setLoading(false);
      });
  });

  // 自动聚焦首个空字段
  if (!usernameEl.value) usernameEl.focus();
  else if (!passwordEl.value) passwordEl.focus();
  else captchaInput.focus();

  fetchCaptcha();
})();
