/**
 * sungminT · 코멘트 초안 중계 서버 (Cloudflare Worker)
 *
 * 역할: API 키를 숨긴 채 admin.html의 요청만 Gemini로 넘긴다.
 *       admin.html에는 이 Worker 주소만 들어가므로 키가 노출되지 않는다.
 *
 * 배포 전 설정 2가지
 *   1) Cloudflare 대시보드 → Workers → Settings → Variables and Secrets
 *      GEMINI_KEY  (Secret으로 추가)
 *   2) 아래 ALLOW_ORIGINS 에 실제 사이트 주소가 맞는지 확인
 */

const ALLOW_ORIGINS = [
  'https://sungmint01.github.io'
];

/* 모델명은 수시로 바뀐다. 앞에서부터 시도해 되는 것을 쓴다.
   사용 가능한 목록은 브라우저에서 <Worker주소>/models 로 확인할 수 있다. */
const MODEL_CANDIDATES = [
  // 무료 한도가 넉넉한 Flash-Lite 계열 우선
  'gemini-3.5-flash-lite',
  'gemini-flash-lite-latest',
  'gemini-3.1-flash-lite',
  'gemini-3.1-flash-lite-preview',
  // 최후 수단: 일반 Flash (무료 한도 적음)
  'gemini-3.6-flash',
  'gemini-flash-latest'
  // gemini-2.5-flash-lite: 2026-10-16 종료로 제거
];
let CACHED_MODEL = null;   // 한 번 성공한 모델을 기억

// 학생 이름·성적 등 개인정보는 보내지 않는다. 키워드만 받는다.
const MAX_KEYWORD_LEN = 200;

function cors(origin) {
  const ok = ALLOW_ORIGINS.includes(origin);
  return {
    'Access-Control-Allow-Origin': ok ? origin : ALLOW_ORIGINS[0],
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400'
  };
}

// 종류별: 무엇을 쓰는지 / 누가 읽는지 / 어떤 존댓말인지
const KIND_INFO = {
  planner: {
    where: '학생이 제출한 학습 플래너에 선생님이 달아주는 코멘트 (학생이 읽음)',
    speech: '해요체 존댓말. 모든 문장이 "~요"로 끝난다. 예: "계획을 꼼꼼하게 세웠어요.", "내일은 오답부터 정리해 봐요."',
    rules: ['상황 언급 → 구체적인 다음 행동 제안 순서로.', '학생을 부르는 호칭이나 이름은 넣지 않는다.']
  },
  homework: {
    where: '학원 수업 기록에 남기는 숙제 관련 코멘트 (학생이 읽음)',
    speech: '해요체 존댓말. 모든 문장이 "~요"로 끝난다. 예: "풀이 과정이 깔끔해졌어요.", "계산 실수만 한 번 더 점검해요."',
    rules: ['상황 언급 → 구체적인 다음 행동 제안 순서로.', '학생을 부르는 호칭이나 이름은 넣지 않는다.']
  },
  clinic: {
    where: '클리닉(보충 수업) 시간에 다룬 내용을 남기는 기록 (학생과 학부모가 함께 읽음)',
    speech: '해요체 존댓말. 모든 문장이 "~요"로 끝난다. 예: "유제 3번 유형을 반복해서 풀었어요.", "다음 클리닉에서 이어서 확인할게요."',
    rules: ['무엇을 다뤘는지 사실 위주로 먼저 쓰고, 다음 복습이나 클리닉에서 할 일을 덧붙인다.', '점수·이름은 넣지 않는다.']
  },
  parent: {
    where: '학부모님께 전하는 메모 (학부모가 읽음)',
    speech: '학부모님께 드리는 합니다체. 모든 문장이 "~니다"로 끝난다. 예: "수업에 성실하게 참여하고 있습니다.", "가정에서 오답노트를 한 번 확인 부탁드립니다."',
    rules: ['인사말과 맺음말(안녕하세요, 감사합니다) 없이 본론만 쓴다.',
            '학생을 가리킬 때는 "아이", "학생", "자녀" 대신 {이름} 을 중괄호 그대로 쓴다. 실제 이름을 지어내지 않는다.',
            '{이름} 뒤 조사는 이름이 모음으로 끝난다고 보고 붙인다. 예: "{이름}가", "{이름}는", "{이름}를", "{이름}의", "{이름}에게".',
            '한 초안에 {이름}은 한두 번만 쓴다.',
            '가정에서 도울 일이 있으면 구체적으로 한 가지만 부탁한다.']
  }
};

function buildPrompt(kind, tone, keywords) {
  const info = KIND_INFO[kind] || KIND_INFO.planner;

  const toneMap = {
    warm:   '따뜻하고 격려하는 말투. 잘한 점을 먼저 짚고, 아쉬운 점은 다음 행동을 제안하는 식으로.',
    plain:  '담백하고 간결한 말투. 과장 없이 사실 위주로. 군더더기 없이.',
    firm:   '분명하고 단호한 말투. 다만 비난하지 않고, 무엇을 바꿔야 하는지 명확하게.'
  };

  return [
    `당신은 한국 고등학교 수학 학원 선생님입니다. ${info.where}를 작성합니다.`,
    '',
    '[존댓말 — 반드시 지킬 것]',
    info.speech,
    '반말 금지: "~해", "~했어", "~하자", "~해라", "~했다", "~한다" 같은 어미를 쓰지 않는다.',
    '',
    '[말투]',
    toneMap[tone] || toneMap.warm,
    '',
    '[규칙]',
    '- 2~3문장으로 쓴다. 한국어. 각 초안은 60자 이상 140자 이내.',
    '- 한 문장으로 끝내지 말 것.',
    ...info.rules.map(x => '- ' + x),
    '- "학생은", "귀하" 같은 딱딱한 표현 금지. 실제 선생님이 말하듯 자연스럽게.',
    '- 이모지 금지.',
    '- 못한 것을 나열하지 말고, 다음에 할 행동을 제시한다.',
    '- 서로 다른 초안 3개를 만든다. 문장 구조와 접근을 다르게.',
    '',
    '[선생님이 준 메모]',
    keywords,
    '',
    '[출력 형식]',
    '설명 없이 초안 3개만. 각 줄 앞에 번호나 기호를 붙이지 말고 줄바꿈으로만 구분.'
  ].join('\n');
}

// 모든 문장이 존댓말 어미(~요 / ~니다 / ~니까)로 끝나는지 검사
function isPolite(draft) {
  const sents = draft.split(/(?<=[.!?])\s+/)
    // 끝의 괄호 보충설명 "(함수의 극한)"은 떼고 어미만 본다
    .map(x => x.replace(/[\s.!?~…"'”’]+$/, '').replace(/\s*\([^()]*\)$/, '').replace(/[\s.!?~…"'”’]+$/, '').trim())
    .filter(Boolean);
  return sents.length > 0 && sents.every(x => /(요|니다|니까)$/.test(x));
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const headers = { ...cors(origin), 'Content-Type': 'application/json; charset=utf-8' };

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors(origin) });

    // 진단용: 이 API 키로 쓸 수 있는 모델 목록 보기
    if (request.method === 'GET' && new URL(request.url).pathname === '/models') {
      if (!env.GEMINI_KEY) return new Response('GEMINI_KEY 미설정', { status: 500 });
      const lr = await fetch('https://generativelanguage.googleapis.com/v1beta/models?key=' + env.GEMINI_KEY);
      const ld = await lr.json();
      const names = (ld.models || [])
        .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
        .map(m => m.name.replace('models/', ''));
      return new Response(JSON.stringify({ usable: names, raw: ld.error || null }, null, 2),
        { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    }

    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'POST만 허용됩니다' }), { status: 405, headers });
    }
    // 다른 사이트에서의 호출 차단 (브라우저 기반 오남용 방지)
    if (!ALLOW_ORIGINS.includes(origin)) {
      return new Response(JSON.stringify({ error: '허용되지 않은 접근' }), { status: 403, headers });
    }
    if (!env.GEMINI_KEY) {
      return new Response(JSON.stringify({ error: 'GEMINI_KEY 미설정' }), { status: 500, headers });
    }

    let body;
    try { body = await request.json(); }
    catch (e) { return new Response(JSON.stringify({ error: '잘못된 요청' }), { status: 400, headers }); }

    const keywords = String(body.keywords || '').trim().slice(0, MAX_KEYWORD_LEN);
    const kind = KIND_INFO[body.kind] ? body.kind : 'planner';
    const tone = ['warm', 'plain', 'firm'].includes(body.tone) ? body.tone : 'warm';
    if (!keywords) {
      return new Response(JSON.stringify({ error: '키워드를 입력하세요' }), { status: 400, headers });
    }

    const promptText = buildPrompt(kind, tone, keywords);
    // 2.5 계열은 내부 '생각'이 출력 토큰을 먹으므로 thinkingBudget을 0으로 둔다.
    // 1.5 계열에는 이 옵션이 없어 400이 나므로 모델별로 나눠 만든다.
    // 생각 끄기 설정이 세대마다 다르다.
    //   2.5 계열: thinkingBudget 0  /  3 계열: thinkingLevel 'minimal' (thinkingBudget을 보내면 400)
    //   지원 안 하는 모델은 400 → thinkingConfig 없이 한 번 더 보낸다 (plain=true)
    function makePayload(model, plain) {
      const cfg = { temperature: 0.95, maxOutputTokens: 4096 };
      if (!plain) {
        if (/2\.5/.test(model)) cfg.thinkingConfig = { thinkingBudget: 0 };
        else if (/(^|-)[3-9]\.|latest/.test(model)) cfg.thinkingConfig = { thinkingLevel: 'minimal' };
      }
      return { contents: [{ parts: [{ text: promptText }] }], generationConfig: cfg };
    }

    // 성공한 모델이 있으면 그것부터, 없으면 후보를 차례로 시도
    const tryList = CACHED_MODEL ? [CACHED_MODEL, ...MODEL_CANDIDATES.filter(m => m !== CACHED_MODEL)] : MODEL_CANDIDATES;

    const sleep = ms => new Promise(r => setTimeout(r, ms));

    try {
      let r = null, lastStatus = 0, lastText = '', usedModel = '';
      // 모델별로 2회까지 (503 혼잡은 잠깐 뒤 풀리는 경우가 많다)
      outer:
      for (const m of tryList) {
        let plain = false;
        for (let attempt = 0; attempt < 3; attempt++) {
          const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${env.GEMINI_KEY}`;
          const resp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(makePayload(m, plain))
          });
          if (resp.ok) { r = resp; usedModel = m; CACHED_MODEL = m; break outer; }
          lastStatus = resp.status;
          lastText = await resp.text();
          // 503(혼잡)·429(속도제한)은 잠깐 쉬고 한 번 더, 그래도 안 되면 다음 모델
          if (resp.status === 503 || resp.status === 429) { await sleep(900); continue; }
          // 400: 생각 설정이 안 맞는 경우가 많다 → 설정 빼고 한 번 더, 그래도 400이면 다음 모델
          if (resp.status === 400 && !plain) { plain = true; continue; }
          // 404·400은 모델 문제 → 다음 모델 (기억해 둔 모델이 사라졌으면 잊는다)
          if (resp.status === 404 || resp.status === 400) { if (CACHED_MODEL === m) CACHED_MODEL = null; break; }
          // 그 외(401 등)는 키 문제 → 중단
          break outer;
        }
      }
      if (!r) {
        let msg;
        if (lastStatus === 503)      msg = 'AI 서버가 혼잡합니다. 20~30초 뒤 다시 눌러 주세요.';
        else if (lastStatus === 429) msg = '잠시 사용량이 많습니다. 1분 뒤 다시 시도해 주세요.';
        else if (lastStatus === 404) msg = '사용 가능한 모델을 찾지 못했습니다. Worker 주소 뒤에 /models 를 붙여 목록을 확인해 주세요.';
        else if (lastStatus === 401 || lastStatus === 403) msg = 'API 키가 올바르지 않습니다.';
        else if (lastStatus === 400) msg = '모든 모델이 요청을 거부했습니다(400). Worker 주소 뒤에 /models 를 붙여 목록을 알려 주세요.';
        else msg = 'AI 서버 오류 (' + lastStatus + ')';
        return new Response(JSON.stringify({ error: msg, detail: lastText.slice(0, 300) }), { status: 502, headers });
      }
      const data = await r.json();
      const cand = (data.candidates || [])[0] || {};
      const parts = (cand.content || {}).parts || [];
      const text = parts.map(p => p.text || '').join('');
      const drafts = text.split('\n')
        .map(s => s.replace(/^\s*[-*\d.)\]]+\s*/, '').trim())
        // 잘린 조각 제외: 길이가 짧거나 문장이 끝나지 않은 것은 버린다
        .filter(s => s.length >= 20 && /[.!?다요]$/.test(s));
      // 반말이 섞인 초안은 버린다 (모델이 지시를 가끔 무시함)
      const polite = drafts.filter(isPolite).slice(0, 3);
      if (!polite.length) {
        const why = cand.finishReason === 'MAX_TOKENS'
          ? '응답이 너무 길어 잘렸습니다. 키워드를 줄여 다시 시도해 주세요.'
          : drafts.length ? '존댓말 초안을 만들지 못했습니다. 한 번 더 눌러 주세요.'
          : '초안을 만들지 못했습니다';
        return new Response(JSON.stringify({ error: why, finishReason: cand.finishReason || null }), { status: 502, headers });
      }
      return new Response(JSON.stringify({ drafts: polite, model: usedModel }), { headers });
    } catch (e) {
      return new Response(JSON.stringify({ error: '연결 실패: ' + e.message }), { status: 502, headers });
    }
  }
};
