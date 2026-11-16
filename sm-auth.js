/* sm-auth.js — 로그인 공용 (모든 페이지가 같은 파일을 쓴다)
   비밀번호는 로그인 서버(Cloudflare Worker)가 확인하고, 통과하면 Firebase 로그인 토큰을 준다.
   firebase-app · firebase-auth 스크립트보다 뒤에 불러야 한다. */
var SM_AUTH_ENDPOINT = 'https://sungmint-auth.zpcp1212.workers.dev';

(function () {
  function fbAuth() {
    if (!firebase.apps.length) {
      var cfg = (typeof SM_CONFIG !== 'undefined') ? SM_CONFIG
              : (typeof firebaseConfig !== 'undefined') ? firebaseConfig : null;
      if (!cfg) throw new Error('Firebase 설정이 없습니다');
      firebase.initializeApp(cfg);
    }
    return firebase.auth();
  }
  function saveProfile(p) { try { sessionStorage.setItem('smProfile', JSON.stringify(p)); } catch (e) {} }
  function readProfile() { try { return JSON.parse(sessionStorage.getItem('smProfile') || 'null'); } catch (e) { return null; } }

  // 로그인. cred = { pw: '...' } 또는 { token: '학부모 링크 토큰' }
  // 성공: { role, sid, profile, roster }  /  실패: Error(안내 문구), err.code = HTTP 상태
  window.smLogin = async function (role, cred) {
    var res, data = null;
    try {
      res = await fetch(SM_AUTH_ENDPOINT + '/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ role: role }, cred || {}))
      });
    } catch (e) {
      throw new Error('로그인 서버에 연결하지 못했습니다');
    }
    try { data = await res.json(); } catch (e) {}
    if (!res.ok || !data || !data.token) {
      var err = new Error((data && data.error) || '로그인하지 못했습니다');
      err.code = res.status;
      throw err;
    }
    var auth = fbAuth();
    // 지금까지와 같이 탭을 닫으면 로그아웃된다
    await auth.setPersistence(firebase.auth.Auth.Persistence.SESSION);
    await auth.signInWithCustomToken(data.token);
    var out = { role: data.role, sid: data.sid || null, profile: data.profile || null };
    saveProfile(out);
    out.roster = data.roster || null;
    return out;
  };

  // 이미 로그인된 상태인지 확인 (새로고침·탭 이동). roles 중 하나일 때만 { role, sid, profile }, 아니면 null
  window.smSession = function (roles) {
    return new Promise(function (resolve) {
      var auth, done = false, off = null;
      try { auth = fbAuth(); } catch (e) { resolve(null); return; }
      off = auth.onAuthStateChanged(function (user) {
        if (done) return;
        done = true;
        if (off) off(); else setTimeout(function () { if (off) off(); }, 0);
        if (!user) { resolve(null); return; }
        user.getIdTokenResult().then(function (t) {
          var c = t.claims || {};
          if (roles.indexOf(c.role) < 0) { resolve(null); return; }
          var p = readProfile();
          var sid = c.sid || null;
          resolve({
            role: c.role, sid: sid,
            profile: (p && p.sid === sid && p.profile) ? p.profile : { name: c.name || '' }
          });
        }).catch(function () { resolve(null); });
      }, function () { if (!done) { done = true; resolve(null); } });
    });
  };

  window.smLogout = function () {
    try { sessionStorage.removeItem('smProfile'); } catch (e) {}
    try { return fbAuth().signOut().catch(function () {}); } catch (e) { return Promise.resolve(); }
  };
})();
