"use strict";
/* ================= 定数 ================= */
const STASH_SEC = 180;   // 仕込み(宣言含む) 3分
const GUESS_SEC = 300;   // 予想 5分
const TOTAL_GAMES = 4;
const STASH_CAP = 50;    // 1ゲームに箱へ入れられる上限(万円)。第4ゲームは2箱合計

// スキルは事前選択なし。1試合に1回、使いたいタイミングで下記から選んで使用する。
const SKILLS = {
  baiPush:    { name:"倍プッシュ",  timing:"仕込み時",   desc:"宣言と同時に全員へ公開。この回に自分が獲得する勝ち点が2倍(正直者ボーナスと重複可)。" },
  sasatsu:    { name:"査察官",     timing:"予想時",     desc:"「相手の箱はN万円以上か?」と1回質問できる。答えは必ず真実。" },
  sashiosae:  { name:"差し押さえ", timing:"予想時",     desc:"予想確定と同時に発動。防御成功(予想>中身)なら差額を勝ち点として獲得。" },
  hoken:      { name:"保険",       timing:"オープン後", desc:"この回に相手が獲得する勝ち点を半減。" },
  yuushi:     { name:"追加融資",   timing:"仕込み時",   desc:"攻撃用現金+20万円 または 予想枠+20万円 のどちらかを選ぶ。" },
};

/* ================= 状態 ================= */
const S = {
  names: ["プレイヤー1", "プレイヤー2"],
  p: [], game: 1, round: null,
};
function newPlayer(){ return { cash:100, budget:100, pts:0, skillUsed:false, usedSkill:null }; }
function newRound(boxes){
  return {
    boxes,
    x:[[],[]], d:[[],[]], y:[[],[]],
    baiPush:[false,false], sashiosae:[false,false],
    hoken:[false,false],
    sasatsu:[false,false], loan:[null,null],
    notes:[],
    applied:false,
  };
}
function useSkill(i, id){
  S.p[i].skillUsed = true;
  S.p[i].usedSkill = id;
}

/* ================= 通信(オンライン対戦) ================= */
const NET = {
  mode: "local",   // local | host | guest
  peer: null, conn: null,
  myIdx: 0,
  started: false,  // host: マッチ開始済みか
  inbox: {},       // game番号 -> {stash, guess, post}
  waiter: null,    // 待機中の再チェック関数
  gameOver: false,
};
function isOnline(){ return NET.mode !== "local"; }
function myIdx(){ return isOnline() ? NET.myIdx : -1; }
function oppIdx(){ return 1 - NET.myIdx; }
function netSend(obj){ if(NET.conn && NET.conn.open) NET.conn.send(obj); }
function inboxFor(g){ if(!NET.inbox[g]) NET.inbox[g] = {}; return NET.inbox[g]; }

function handleNetData(msg){
  if(!msg || typeof msg !== "object") return;
  if(msg.type === "join"){ // host側: ゲストの参加通知
    if(NET.mode !== "host" || NET.started) return;
    NET.started = true;
    S.names[1] = String(msg.name).slice(0,10) || "プレイヤー2";
    netSend({ type:"start", name: S.names[0] });
    startMatch();
    return;
  }
  if(msg.type === "start"){ // guest側: ホストの開始通知
    S.names[0] = String(msg.name).slice(0,10) || "プレイヤー1";
    startMatch();
    return;
  }
  if(msg.type === "stash" || msg.type === "guess" || msg.type === "post"){
    inboxFor(msg.game)[msg.type] = msg;
  }
  if(NET.waiter) NET.waiter();
}

function netError(text){
  if(NET.gameOver) return;
  clearTimer();
  show(`
    <h1 style="font-size:26px">通信エラー</h1>
    <div class="card center">
      <p>${esc(text)}</p>
      <p class="note">相手が退出したか、接続が切断されました。</p>
    </div>
    <button class="btn" id="ok">タイトルへ戻る</button>
  `);
  document.getElementById("ok").onclick = ()=>location.reload();
}

function setupConn(c){
  NET.conn = c;
  c.on("data", handleNetData);
  c.on("close", ()=>netError("接続が切れました。"));
  c.on("error", (e)=>netError("通信エラー: " + e));
}

function randomCode(){
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for(let k=0;k<6;k++) s += chars[Math.floor(Math.random()*chars.length)];
  return s;
}

function createRoom(name){
  if(typeof Peer === "undefined"){ alert("通信ライブラリを読み込めませんでした。ネット接続を確認してください。"); return; }
  NET.mode = "host"; NET.myIdx = 0;
  S.names[0] = name;
  const code = randomCode();
  show(`
    <h1 style="font-size:26px">部屋を作成中…</h1>
    <div class="card center"><div class="waiting-dots">接続サーバーに登録しています</div></div>
  `);
  NET.peer = new Peer("moneygame-" + code);
  NET.peer.on("open", ()=>{
    show(`
      <h1 style="font-size:26px">部屋を作りました</h1>
      <div class="card center">
        <p class="note">相手に以下の<b>部屋コード</b>を伝えてください</p>
        <div class="big" style="font-size:44px;letter-spacing:.3em">${code}</div>
        <hr class="sep">
        <div class="waiting-dots">相手の参加を待っています</div>
      </div>
      <button class="btn sub" id="cancel">やめる</button>
    `);
    document.getElementById("cancel").onclick = ()=>location.reload();
  });
  NET.peer.on("connection", (c)=>{
    if(NET.conn){ try{ c.close(); }catch(e){} return; } // 3人目以降は拒否
    setupConn(c);
  });
  NET.peer.on("error", (e)=>{
    if(e.type === "unavailable-id"){ createRoom(name); return; } // コード衝突→再生成
    netError("接続サーバーに繋がりませんでした(" + e.type + ")");
  });
}

function joinRoom(name, code){
  if(typeof Peer === "undefined"){ alert("通信ライブラリを読み込めませんでした。ネット接続を確認してください。"); return; }
  if(!/^[A-Za-z0-9]{6}$/.test(code)){ alert("部屋コードは6文字の英数字です。"); return; }
  NET.mode = "guest"; NET.myIdx = 1;
  S.names[1] = name;
  show(`
    <h1 style="font-size:26px">参加中…</h1>
    <div class="card center"><div class="waiting-dots">部屋 ${esc(code.toUpperCase())} に接続しています</div></div>
  `);
  NET.peer = new Peer();
  NET.peer.on("open", ()=>{
    const c = NET.peer.connect("moneygame-" + code.toUpperCase(), { reliable:true, serialization:"json" });
    setupConn(c);
    c.on("open", ()=>{ netSend({ type:"join", name }); });
  });
  NET.peer.on("error", (e)=>{
    if(e.type === "peer-unavailable"){ netError("その部屋コードは見つかりませんでした。"); return; }
    netError("接続サーバーに繋がりませんでした(" + e.type + ")");
  });
}

function startMatch(){
  S.p = [newPlayer(), newPlayer()];
  S.game = 1;
  NET.inbox = {};
  NET.gameOver = false;
  gameIntro();
}

function waitScreen(message){
  return `
    ${isOnline() ? statusBar(myIdx()) : ""}
    <h2 class="center">⏳ 待機中</h2>
    <div class="card center">
      <div class="waiting-dots">${esc(message)}</div>
      <p class="note">相手の制限時間が切れると自動的に進みます。</p>
    </div>`;
}
function waitFor(check, message){
  const tryProceed = ()=>{ if(check()) NET.waiter = null; };
  NET.waiter = tryProceed;
  show(waitScreen(message));
  tryProceed();
}

/* ================= ユーティリティ ================= */
const app = document.getElementById("app");
function show(html){ clearTimer(); app.innerHTML = html; window.scrollTo(0,0); }
function esc(s){ return String(s).replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
function pcls(i){ return i===0 ? "p1c" : "p2c"; }
function fmtPts(sen){ // 千円単位の勝ち点 → 表示
  const man = sen/10;
  return (Number.isInteger(man) ? man : man.toFixed(1)) + "万円";
}
function fmtMan(n){ return n + "万円"; }
function clampInt(v,min,max){ v = Math.floor(Number(v)||0); return Math.max(min, Math.min(max, v)); }

let timerHandle = null, timerRemain = 0;
function clearTimer(){ if(timerHandle){ clearInterval(timerHandle); timerHandle=null; } }
function startTimer(sec, elId, onExpire){
  let remain = sec;
  timerRemain = remain;
  const el = ()=>document.getElementById(elId);
  const draw = ()=>{
    const e = el(); if(!e) return;
    const m = Math.floor(remain/60), s = remain%60;
    e.textContent = `⏱ ${m}:${String(s).padStart(2,"0")}`;
    e.classList.toggle("warn", remain<=30);
  };
  draw();
  timerHandle = setInterval(()=>{
    remain--;
    timerRemain = remain;
    if(remain<=0){ clearTimer(); onExpire(); return; }
    draw();
  }, 1000);
}

function statusBar(i){
  const p = S.p[i];
  return `<div class="status">
    <span><b class="${pcls(i)}">${esc(S.names[i])}</b></span>
    <span>残金 <b>${fmtMan(p.cash)}</b></span>
    <span>予想枠 <b>${fmtMan(p.budget)}</b></span>
    <span>勝ち点 <b>${fmtPts(p.pts)}</b></span>
    <span>スキル <b>${p.skillUsed ? "使用済" : "未使用"}</b></span>
  </div>`;
}

function skillListHtml(){
  return Object.values(SKILLS).map(s=>`
    <div class="skill-opt">
      <span class="nm">${s.name}</span><span class="tp">[${s.timing}]</span>
      <div class="ds">${s.desc}</div>
    </div>`).join("");
}

/* ================= 勝ち点計算 ================= */
function calcAtk(i){ // iの攻撃獲得(千円)。宣言一致は×1.2(=係数12)
  const r = S.round, j = 1-i;
  let s = 0;
  r.x[i].forEach((x,k)=>{
    const y = r.y[j][k] ?? 0;
    if(x > y) s += (x - y) * (r.d[i][k] === x ? 12 : 10);
  });
  return s;
}
function calcDef(i){ // iの防御側獲得(ぴったり賞+差し押さえ)(千円)
  const r = S.round, j = 1-i;
  let s = 0;
  r.x[j].forEach((x,k)=>{
    const y = r.y[i][k] ?? 0;
    if(x === y) s += x * 10;               // ぴったり賞(ボーナスなし)
    if(y > x && r.sashiosae[i]) s += (y - x) * 10; // 差し押さえ
  });
  return s;
}
function roundGain(i){
  const r = S.round;
  let g = calcAtk(i) + calcDef(i);
  if(r.baiPush[i]) g *= 2;
  if(r.hoken[1-i]) g = Math.floor(g/2);
  return g;
}

/* ================= 相手のコミットを自分の状態へ反映 ================= */
function applyOppStash(msg){
  const j = oppIdx(), r = S.round, p = S.p[j];
  if(msg.loan === "cash"){ p.cash += 20; useSkill(j,"yuushi"); r.notes.push(`${esc(S.names[j])}【追加融資】現金+20万円`); }
  else if(msg.loan === "budget"){ p.budget += 20; useSkill(j,"yuushi"); r.notes.push(`${esc(S.names[j])}【追加融資】予想枠+20万円`); }
  if(msg.baiPush){ r.baiPush[j] = true; useSkill(j,"baiPush"); }
  r.x[j] = msg.x.map(v=>clampInt(v,0,STASH_CAP));
  r.d[j] = msg.d.map(v=>clampInt(v,0,STASH_CAP));
  p.cash -= r.x[j].reduce((a,b)=>a+b,0);
}
function applyOppGuess(msg){
  const j = oppIdx(), r = S.round, p = S.p[j];
  if(msg.sasatsu){ r.sasatsu[j] = true; useSkill(j,"sasatsu"); r.notes.push(`${esc(S.names[j])}【査察官】を使用(質問内容は非公開)`); }
  if(msg.sashiosae){ r.sashiosae[j] = true; useSkill(j,"sashiosae"); }
  r.y[j] = msg.y.map(v=>clampInt(v,0,999));
  p.budget -= r.y[j].reduce((a,b)=>a+b,0);
}
function applyPostAction(i, action){
  if(action === "hoken"){ S.round.hoken[i] = true; useSkill(i,"hoken"); }
}

/* ================= 画面: タイトル ================= */
function titleScreen(){
  show(`
    <h1>マネーゲーム</h1>
    <p class="tagline">― 貸与された100万円。返せなければ、どうなるか分かるな? ―</p>
    <div class="card note">
      ・2人対戦。各自に <b>現金100万円</b>(攻撃用)と <b>予想枠100万円</b>(防御用)が貸与される。<br>
      ・毎ゲーム同時に、箱へ金を仕込み(3分)、中身を宣言し(嘘OK)、相手の箱を予想する(5分)。<br>
      ・箱に入れられるのは <b>1ゲーム合計50万円まで</b>。<br>
      ・中身 &gt; 予想 → 攻撃側が差額を獲得。ぴったり → 防御側が中身と同額を獲得。<br>
      ・宣言が真実なら獲得20%アップ。<br>
      ・全4ゲーム。最終ゲームは <b>ダブルボックス</b>。<br>
      ・<b style="color:var(--red)">敗者には……お迎えが来る。</b>
    </div>
    <div class="card">
      <h2 style="margin-top:0">🏠 1台で対戦(ホットシート)</h2>
      <label>プレイヤー1の名前</label>
      <input type="text" id="n1" maxlength="10" placeholder="プレイヤー1">
      <label>プレイヤー2の名前</label>
      <input type="text" id="n2" maxlength="10" placeholder="プレイヤー2">
      <button class="btn" id="goLocal">この端末で開始</button>
    </div>
    <div class="card">
      <h2 style="margin-top:0">🌐 オンライン対戦(2端末)</h2>
      <label>あなたの名前</label>
      <input type="text" id="nn" maxlength="10" placeholder="名前">
      <button class="btn" id="goHost">部屋を作る(コードを発行)</button>
      <hr class="sep">
      <label>相手から聞いた部屋コード</label>
      <input type="text" id="code" maxlength="6" placeholder="例: A2C4EF" style="text-transform:uppercase">
      <button class="btn sub" id="goJoin">部屋に入る</button>
    </div>
    <div class="card">
      <h2 style="margin-top:0">スキル(1試合に1回)</h2>
      <p class="note">事前選択はなし。使いたいタイミングが来たら、その場で下記から1つ選んで使用できる。</p>
      ${skillListHtml()}
    </div>
  `);
  document.getElementById("goLocal").onclick = ()=>{
    NET.mode = "local";
    S.names[0] = document.getElementById("n1").value.trim() || "プレイヤー1";
    S.names[1] = document.getElementById("n2").value.trim() || "プレイヤー2";
    startMatch();
  };
  document.getElementById("goHost").onclick = ()=>{
    const name = document.getElementById("nn").value.trim() || "プレイヤー1";
    createRoom(name);
  };
  document.getElementById("goJoin").onclick = ()=>{
    const name = document.getElementById("nn").value.trim() || "プレイヤー2";
    const code = document.getElementById("code").value.trim();
    joinRoom(name, code);
  };
}

function handover(i, what, next){
  show(`
    <div class="handover">
      <div class="note">端末を渡してください</div>
      <div class="who ${pcls(i)}">${esc(S.names[i])}</div>
      <div class="note">${esc(what)}<br>他のプレイヤーは画面を見ないでください。</div>
      <button class="btn" id="ok" style="margin-top:36px">${esc(S.names[i])} です ― 画面を開く</button>
    </div>
  `);
  document.getElementById("ok").onclick = next;
}

/* ================= 画面: ゲーム進行 ================= */
function gameIntro(){
  const g = S.game;
  const special = g===TOTAL_GAMES;
  show(`
    <h1 style="font-size:26px">第${g}ゲーム${special?' <span class="badge">FINAL</span>':""}</h1>
    ${special ? `
      <div class="card">
        <h2>💼 ダブルボックス</h2>
        <p class="note">
          最終ゲームは箱が<b>2つ</b>。残金を2つの箱へ自由に振り分けろ(片方0でも可。2箱合計で上限${STASH_CAP}万円)。<br>
          宣言も箱ごとに行い、相手は<b>両方の箱それぞれ</b>を予想する(どちらも予想枠を消費)。<br>
          判定は箱ごとに独立。宣言が一致した箱の獲得は20%アップ。
        </p>
      </div>` : `
      <div class="card note">
        仕込み(3分) → 宣言の同時公開 → 予想(5分) → 一斉オープン。<br>
        箱に入れられるのは1ゲーム合計${STASH_CAP}万円まで。時間切れは「0」として確定するので注意。
      </div>`}
    <table class="res">
      <tr><th></th><th class="p1c">${esc(S.names[0])}</th><th class="p2c">${esc(S.names[1])}</th></tr>
      <tr><td>勝ち点</td><td>${fmtPts(S.p[0].pts)}</td><td>${fmtPts(S.p[1].pts)}</td></tr>
      <tr><td>残金</td><td>${fmtMan(S.p[0].cash)}</td><td>${fmtMan(S.p[1].cash)}</td></tr>
      <tr><td>予想枠</td><td>${fmtMan(S.p[0].budget)}</td><td>${fmtMan(S.p[1].budget)}</td></tr>
      <tr><td>スキル</td><td>${S.p[0].skillUsed?"使用済":"未使用"}</td><td>${S.p[1].skillUsed?"使用済":"未使用"}</td></tr>
    </table>
    <button class="btn" id="ok">仕込みフェイズへ</button>
  `);
  document.getElementById("ok").onclick = ()=>{
    S.round = newRound(special ? 2 : 1);
    if(isOnline()) stashScreen(myIdx());
    else handover(0, "仕込み(秘密・3分)", ()=>stashScreen(0));
  };
}

/* ---- 仕込み ---- */
function stashScreen(i, remainSec){
  const p = S.p[i], r = S.round;
  const boxes = r.boxes;
  const cap = Math.min(STASH_CAP, p.cash); // このゲームで箱に入れられる合計上限
  const canSkill = !p.skillUsed;
  const boxInputs = boxes===2 ? `
    <label>箱A に入れる金額(万円)</label>
    <input type="number" id="x0" min="0" max="${cap}" value="0">
    <label>箱B に入れる金額(万円)</label>
    <input type="number" id="x1" min="0" max="${cap}" value="0">
    <div class="note center" id="sumNote">合計 0 / 上限 ${cap}万円(残金 ${p.cash}万円)</div>
    <hr class="sep">
    <label>宣言: 箱A の中身(嘘OK)</label>
    <input type="number" id="d0" min="0" max="${STASH_CAP}" value="0">
    <label>宣言: 箱B の中身(嘘OK)</label>
    <input type="number" id="d1" min="0" max="${STASH_CAP}" value="0">
  ` : `
    <label>箱に入れる金額(万円) ― 0〜${cap}(1ゲーム上限${STASH_CAP}万円)</label>
    <input type="number" id="x0" min="0" max="${cap}" value="0">
    <hr class="sep">
    <label>宣言: 「箱には○万円入っている」(嘘OK)</label>
    <input type="number" id="d0" min="0" max="${STASH_CAP}" value="0">
  `;
  show(`
    ${statusBar(i)}
    <div class="timer" id="tm"></div>
    <h2>💰 仕込み ${boxes===2?"(ダブルボックス)":""}</h2>
    <div class="card">${boxInputs}</div>
    ${canSkill ? `
      <div class="card">
        <div style="color:var(--gold);font-weight:bold">スキル(このタイミングで使えるもの)</div>
        <hr class="sep">
        <div class="nm" style="font-weight:bold">追加融資</div>
        <div class="row">
          <button class="btn sub" id="loanCash">現金 +20万円</button>
          <button class="btn sub" id="loanBudget">予想枠 +20万円</button>
        </div>
        <hr class="sep">
        <div class="checkline">
          <input type="checkbox" id="bai">
          <label for="bai" style="margin:0;font-size:15px;color:var(--text)">
            倍プッシュを発動する<br><span class="note">※宣言の公開時に全員へ知らされます。獲得2倍</span>
          </label>
        </div>
        <p class="note">スキルは1試合に1回だけ。どちらか一方しか使えません。</p>
      </div>` : ""}
    <button class="btn" id="ok">箱を閉じる(確定)</button>
  `);
  // 入力段階で上限超過を防ぐ(単箱: 上限cap / 2箱: 合計がcapに収まるよう編集中の欄を丸める)
  if(boxes===2){
    const clampPair = (edited, other)=>{
      const eEl = document.getElementById("x"+edited), oEl = document.getElementById("x"+other);
      const oVal = clampInt(oEl.value, 0, cap);
      if(Number(eEl.value) < 0) eEl.value = 0;
      if(Number(eEl.value) + oVal > cap) eEl.value = cap - oVal;
      const a = clampInt(document.getElementById("x0").value,0,cap);
      const b = clampInt(document.getElementById("x1").value,0,cap);
      const el = document.getElementById("sumNote");
      el.textContent = `合計 ${a+b} / 上限 ${cap}万円(残金 ${p.cash}万円)`;
    };
    document.getElementById("x0").oninput = ()=>clampPair(0,1);
    document.getElementById("x1").oninput = ()=>clampPair(1,0);
  } else {
    const xEl = document.getElementById("x0");
    xEl.oninput = ()=>{
      if(Number(xEl.value) > cap) xEl.value = cap;
      if(Number(xEl.value) < 0) xEl.value = 0;
    };
  }
  if(canSkill){
    const useLoan = (kind)=>{
      const rem = timerRemain; // 残り時間を引き継ぐ
      useSkill(i, "yuushi");
      r.loan[i] = kind;
      if(kind==="cash"){ p.cash += 20; r.notes.push(`${esc(S.names[i])}【追加融資】現金+20万円`); }
      else { p.budget += 20; r.notes.push(`${esc(S.names[i])}【追加融資】予想枠+20万円`); }
      stashScreen(i, rem); // 再描画(残金反映)
    };
    document.getElementById("loanCash").onclick   = ()=>useLoan("cash");
    document.getElementById("loanBudget").onclick = ()=>useLoan("budget");
  }
  const commit = (timeout)=>{
    const remBefore = timerRemain;
    clearTimer();
    let xs = [], ds = [];
    if(timeout){
      xs = Array(boxes).fill(0); ds = Array(boxes).fill(0);
    } else {
      for(let k=0;k<boxes;k++){
        xs.push(clampInt(document.getElementById("x"+k).value, 0, cap));
        ds.push(clampInt(document.getElementById("d"+k).value, 0, STASH_CAP));
      }
      const total = xs.reduce((a,b)=>a+b,0);
      if(total > cap){ alert(`合計が上限(${cap}万円)を超えています。`); startTimerAgain(remBefore); return; }
      const bai = document.getElementById("bai");
      if(bai && bai.checked && !p.skillUsed){
        r.baiPush[i] = true; useSkill(i, "baiPush");
      }
    }
    r.x[i] = xs; r.d[i] = ds;
    p.cash -= xs.reduce((a,b)=>a+b,0);
    if(isOnline()){
      netSend({ type:"stash", game:S.game, x:xs, d:ds, baiPush:r.baiPush[i], loan:r.loan[i] });
      waitFor(()=>{
        const m = inboxFor(S.game).stash;
        if(!m) return false;
        inboxFor(S.game).stash = null;
        applyOppStash(m);
        declReveal();
        return true;
      }, "相手の仕込みを待っています…");
    }
    else if(i===0) handover(1, "仕込み(秘密・3分)", ()=>stashScreen(1));
    else declReveal();
  };
  const startTimerAgain = (sec)=>startTimer(sec ?? STASH_SEC, "tm", ()=>{
    alert("時間切れ! 0万円(宣言0)として確定します。");
    commit(true);
  });
  document.getElementById("ok").onclick = ()=>commit(false);
  startTimerAgain(remainSec);
}

/* ---- 宣言の同時公開 ---- */
function declReveal(){
  const r = S.round;
  const line = (i)=>{
    const decl = r.d[i].map((d,k)=> r.boxes===2 ? `箱${"AB"[k]}: <b>${d}万円</b>` : `<b>${d}万円</b>`).join(" / ");
    return `<div class="card center">
      <span class="${pcls(i)}" style="font-size:17px;font-weight:bold">${esc(S.names[i])}</span>
      <div class="big">「中身は ${decl} だ」</div>
      ${r.baiPush[i] ? `<span class="badge">倍プッシュ発動!!</span>` : ""}
    </div>`;
  };
  show(`
    <h2 class="center">📢 宣言 ― 同時公開</h2>
    <p class="note center">(嘘かもしれない)</p>
    ${line(0)}${line(1)}
    <button class="btn" id="ok">予想フェイズへ</button>
  `);
  document.getElementById("ok").onclick = ()=>{
    if(isOnline()) guessScreen(myIdx());
    else handover(0, "予想(秘密・5分)", ()=>guessScreen(0));
  };
}

/* ---- 予想 ---- */
function guessScreen(i){
  const p = S.p[i], r = S.round, j = 1-i;
  const boxes = r.boxes;
  const canSkill = !p.skillUsed;
  const oppDecl = r.d[j].map((d,k)=> boxes===2 ? `箱${"AB"[k]}: ${d}万円` : `${d}万円`).join(" / ");
  const guessInputs = boxes===2 ? `
    <label>相手の箱A の予想</label>
    <input type="number" id="y0" min="0" max="${p.budget}" value="0">
    <label>相手の箱B の予想</label>
    <input type="number" id="y1" min="0" max="${p.budget}" value="0">
    <div class="note center" id="sumNote">予想合計 0 / 残り枠 ${p.budget}万円</div>
  ` : `
    <label>相手の箱の中身を予想(0〜${p.budget})</label>
    <input type="number" id="y0" min="0" max="${p.budget}" value="0">
  `;
  show(`
    ${statusBar(i)}
    <div class="timer" id="tm"></div>
    <h2>🔍 予想</h2>
    <div class="card center note">
      相手 <b class="${pcls(j)}">${esc(S.names[j])}</b> の宣言: <b style="color:var(--text)">「${oppDecl}」</b>
      ${r.baiPush[j] ? '<br><span class="badge">相手は倍プッシュ発動中!</span>' : ""}
      <br>相手の残金(仕込み前): ${fmtMan(S.p[j].cash + r.x[j].reduce((a,b)=>a+b,0))}
    </div>
    ${canSkill ? `
      <div class="card">
        <div style="color:var(--gold);font-weight:bold">スキル(このタイミングで使えるもの)</div>
        <hr class="sep">
        <div class="nm" style="font-weight:bold">査察官 ― 「相手の箱はN万円以上か?」(回答は必ず真実)</div>
        ${boxes===2 ? `<label>対象の箱</label>
          <div class="row"><button class="btn sub" id="qa">箱A に質問</button><button class="btn sub" id="qb">箱B に質問</button></div>` : ""}
        <label>N =</label>
        <input type="number" id="qn" min="1" max="${STASH_CAP}" value="25">
        ${boxes===2 ? "" : `<button class="btn sub" id="qa">質問する</button>`}
        <div class="big" id="ans"></div>
        <hr class="sep">
        <div class="checkline">
          <input type="checkbox" id="szc">
          <label for="szc" style="margin:0;font-size:15px;color:var(--text)">
            差し押さえを発動する<br><span class="note">※防御成功(予想&gt;中身)なら差額を獲得。オープン時に公開されます</span>
          </label>
        </div>
        <p class="note">スキルは1試合に1回だけ。どちらか一方しか使えません。</p>
      </div>` : ""}
    <div class="card">${guessInputs}</div>
    <button class="btn" id="ok">予想を確定</button>
  `);
  // 入力段階で残り予想枠の超過を防ぐ
  if(boxes===2){
    const clampPair = (edited, other)=>{
      const eEl = document.getElementById("y"+edited), oEl = document.getElementById("y"+other);
      const oVal = clampInt(oEl.value, 0, p.budget);
      if(Number(eEl.value) < 0) eEl.value = 0;
      if(Number(eEl.value) + oVal > p.budget) eEl.value = p.budget - oVal;
      const a = clampInt(document.getElementById("y0").value,0,p.budget);
      const b = clampInt(document.getElementById("y1").value,0,p.budget);
      document.getElementById("sumNote").textContent = `予想合計 ${a+b} / 残り枠 ${p.budget}万円`;
    };
    document.getElementById("y0").oninput = ()=>clampPair(0,1);
    document.getElementById("y1").oninput = ()=>clampPair(1,0);
  } else {
    const yEl = document.getElementById("y0");
    yEl.oninput = ()=>{
      if(Number(yEl.value) > p.budget) yEl.value = p.budget;
      if(Number(yEl.value) < 0) yEl.value = 0;
    };
  }
  if(canSkill){
    const ask = (boxIdx)=>{
      if(p.skillUsed) return;
      const n = clampInt(document.getElementById("qn").value,1,STASH_CAP);
      const truth = (r.x[j][boxIdx] ?? 0) >= n;
      useSkill(i, "sasatsu");
      r.sasatsu[i] = true;
      r.notes.push(`${esc(S.names[i])}【査察官】を使用(質問内容は非公開)`);
      document.getElementById("ans").textContent =
        (boxes===2 ? `箱${"AB"[boxIdx]}: ` : "") + (truth ? `YES ― ${n}万円以上ある` : `NO ― ${n}万円未満だ`);
      // スキルは1回きり: 他の選択肢を無効化
      ["qa","qb"].forEach(id=>{ const b=document.getElementById(id); if(b) b.disabled = true; });
      const szc = document.getElementById("szc");
      if(szc){ szc.checked = false; szc.disabled = true; }
    };
    const qa = document.getElementById("qa"); if(qa) qa.onclick = ()=>ask(0);
    const qb = document.getElementById("qb"); if(qb) qb.onclick = ()=>ask(1);
  }
  const commit = (timeout)=>{
    const remBefore = timerRemain;
    clearTimer();
    let ys = [];
    if(timeout){
      ys = Array(boxes).fill(0);
    } else {
      for(let k=0;k<boxes;k++) ys.push(clampInt(document.getElementById("y"+k).value, 0, p.budget));
      const total = ys.reduce((a,b)=>a+b,0);
      if(total > p.budget){ alert(`予想の合計が残り枠(${p.budget}万円)を超えています。`); restart(remBefore); return; }
      const szc = document.getElementById("szc");
      if(szc && szc.checked && !p.skillUsed){
        r.sashiosae[i] = true; useSkill(i, "sashiosae");
      }
    }
    r.y[i] = ys;
    p.budget -= ys.reduce((a,b)=>a+b,0);
    if(isOnline()){
      netSend({ type:"guess", game:S.game, y:ys, sashiosae:r.sashiosae[i], sasatsu:r.sasatsu[i] });
      waitFor(()=>{
        const m = inboxFor(S.game).guess;
        if(!m) return false;
        inboxFor(S.game).guess = null;
        applyOppGuess(m);
        openScreen();
        return true;
      }, "相手の予想を待っています…");
    }
    else if(i===0) handover(1, "予想(秘密・5分)", ()=>guessScreen(1));
    else openScreen();
  };
  const restart = (sec)=>startTimer(sec ?? GUESS_SEC, "tm", ()=>{
    alert("時間切れ! 予想0として確定します(枠の消費なし)。");
    commit(true);
  });
  document.getElementById("ok").onclick = ()=>commit(false);
  restart();
}

/* ---- オープン ---- */
function openScreen(){
  show(`
    <h2 class="center">運命のオープン</h2>
    <div class="box-visual">📦　📦</div>
    <p class="note center">両者の箱を同時に開ける――</p>
    <button class="btn danger" id="ok">オープン!!</button>
  `);
  document.getElementById("ok").onclick = ()=>postSkillFlow(0);
}

// オープン後スキル判断(スキル未使用のプレイヤーだけ順番に確認。使用宣言は公開情報)
function postSkillFlow(k){
  if(k > 1){ resultScreen(); return; }
  if(S.p[k].skillUsed){ postSkillFlow(k+1); return; }
  if(!isOnline()){
    postSkillScreen(k, (action)=>{ applyPostAction(k, action); postSkillFlow(k+1); });
    return;
  }
  if(k === myIdx()){
    postSkillScreen(k, (action)=>{
      applyPostAction(k, action);
      netSend({ type:"post", game:S.game, action });
      postSkillFlow(k+1);
    });
  } else {
    waitFor(()=>{
      const m = inboxFor(S.game).post;
      if(!m) return false;
      inboxFor(S.game).post = null;
      applyPostAction(oppIdx(), m.action);
      postSkillFlow(k+1);
      return true;
    }, "相手のスキル判断を待っています…");
  }
}

function revealTable(){
  const r = S.round;
  const rows = [];
  for(const i of [0,1]){
    const j = 1-i;
    r.x[i].forEach((x,k)=>{
      const y = r.y[j][k] ?? 0;
      const boxName = r.boxes===2 ? `箱${"AB"[k]}` : "箱";
      const honest = r.d[i][k]===x;
      let judge;
      if(x>y) judge = `<span class="gain">攻撃側 +${fmtPts((x-y)*(honest?12:10))}</span>${honest?'<br><span class="note">宣言一致+20%</span>':""}`;
      else if(x===y) judge = `<span class="gain">ぴったり賞! 防御側 +${fmtPts(x*10)}</span>`;
      else judge = `防御成功${r.sashiosae[j]?`<br><span class="gain">差し押さえ +${fmtPts((y-x)*10)}</span>`:""}`;
      rows.push(`<tr>
        <td class="${pcls(i)}">${esc(S.names[i])} の${boxName}</td>
        <td><b>${x}</b>${honest?" ✅":""}</td>
        <td>${r.d[i][k]}</td>
        <td>${y}</td>
        <td>${judge}</td>
      </tr>`);
    });
  }
  return `<table class="res">
    <tr><th></th><th>中身</th><th>宣言</th><th>相手の予想</th><th>判定</th></tr>
    ${rows.join("")}
  </table>`;
}

/* ---- オープン後スキル(公開判断) ---- */
function postSkillScreen(i, next){
  const j = 1-i;
  const myGain = roundGain(i), oppGain = roundGain(j);
  const canHoken = oppGain > 0;
  show(`
    ${statusBar(i)}
    <h2>オープン後のスキル判断 ― <span class="${pcls(i)}">${esc(S.names[i])}</span></h2>
    ${revealTable()}
    <div class="card center note">
      この回の獲得見込み ― ${esc(S.names[i])}: <b class="gain">${fmtPts(myGain)}</b> / 相手: <b>${fmtPts(oppGain)}</b>
    </div>
    <div class="card">
      <div style="color:var(--gold);font-weight:bold">スキル(このタイミングで使えるもの)</div>
      ${canHoken ? `
        <p class="note">【保険】相手のこの回の獲得 ${fmtPts(oppGain)} → <b>${fmtPts(Math.floor(oppGain/2))}</b> に半減。</p>
        <button class="btn danger" id="useHoken">保険を使う</button>` : `<p class="note">【保険】相手の獲得が0のため使用不可。</p>`}
    </div>
    <button class="btn" id="ok">使わずに進む</button>
  `);
  const uh = document.getElementById("useHoken");
  if(uh) uh.onclick = ()=>next("hoken");
  document.getElementById("ok").onclick = ()=>next("none");
}

/* ---- ラウンド結果 ---- */
function resultScreen(){
  const r = S.round;
  if(!r.applied){
    r.applied = true;
    for(const i of [0,1]){
      S.p[i].pts += roundGain(i);
    }
  }
  const skillNotes = [...r.notes];
  for(const i of [0,1]){
    if(r.baiPush[i])     skillNotes.push(`${esc(S.names[i])}【倍プッシュ】獲得2倍!`);
    if(r.sashiosae[i])   skillNotes.push(`${esc(S.names[i])}【差し押さえ】発動!`);
    if(r.hoken[i])       skillNotes.push(`${esc(S.names[i])}【保険】相手の獲得を半減!`);
  }
  show(`
    <h2 class="center reveal-box">第${S.game}ゲーム 結果</h2>
    ${revealTable()}
    ${skillNotes.length ? `<div class="card center" style="color:var(--gold)">${skillNotes.join("<br>")}</div>` : ""}
    <div class="card">
      <table class="res">
        <tr><th></th><th class="p1c">${esc(S.names[0])}</th><th class="p2c">${esc(S.names[1])}</th></tr>
        <tr><td>この回の獲得</td><td class="gain">+${fmtPts(roundGain(0))}</td><td class="gain">+${fmtPts(roundGain(1))}</td></tr>
        <tr><td><b>勝ち点合計</b></td><td><b>${fmtPts(S.p[0].pts)}</b></td><td><b>${fmtPts(S.p[1].pts)}</b></td></tr>
        <tr><td>残金</td><td>${fmtMan(S.p[0].cash)}</td><td>${fmtMan(S.p[1].cash)}</td></tr>
        <tr><td>予想枠</td><td>${fmtMan(S.p[0].budget)}</td><td>${fmtMan(S.p[1].budget)}</td></tr>
      </table>
    </div>
    <button class="btn" id="ok">${S.game < TOTAL_GAMES ? "次のゲームへ" : "最終結果へ"}</button>
  `);
  document.getElementById("ok").onclick = ()=>{
    if(S.game < TOTAL_GAMES){ S.game++; gameIntro(); }
    else finalScreen();
  };
}

/* ================= 最終結果と回収演出 ================= */
function finalScreen(){
  NET.gameOver = true;
  let winner, loser, tieNote = "";
  if(S.p[0].pts !== S.p[1].pts){
    winner = S.p[0].pts > S.p[1].pts ? 0 : 1;
  } else if(S.p[0].cash !== S.p[1].cash){
    winner = S.p[0].cash > S.p[1].cash ? 0 : 1;
    tieNote = "(勝ち点同点のため残金勝負)";
  } else {
    drawScreen(); return;
  }
  loser = 1 - winner;
  show(`
    <h1 style="font-size:26px">全4ゲーム終了</h1>
    <div class="card">
      <table class="res">
        <tr><th></th><th class="p1c">${esc(S.names[0])}</th><th class="p2c">${esc(S.names[1])}</th></tr>
        <tr><td><b>最終勝ち点</b></td><td><b>${fmtPts(S.p[0].pts)}</b></td><td><b>${fmtPts(S.p[1].pts)}</b></td></tr>
        <tr><td>残金</td><td>${fmtMan(S.p[0].cash)}</td><td>${fmtMan(S.p[1].cash)}</td></tr>
      </table>
      <div class="big">勝者: <span class="${pcls(winner)}">${esc(S.names[winner])}</span></div>
      <p class="note center">${tieNote}</p>
    </div>
    <p class="note center">……ところで、負けた方の精算がまだのようだ。</p>
    <button class="btn danger" id="ok">精算の時間</button>
  `);
  document.getElementById("ok").onclick = ()=>cutscene(winner, loser);
}

function drawScreen(){
  NET.gameOver = true;
  show(`
    <h1 style="font-size:26px">引き分け</h1>
    <div class="card center">
      <div class="big">両者 完全同点</div>
      <p class="note">黒服たちは顔を見合わせ、静かに去っていった。<br>――今回は、二人とも生還だ。</p>
    </div>
    <button class="btn" id="ok">もう一度遊ぶ</button>
  `);
  document.getElementById("ok").onclick = ()=>location.reload();
}

function cutscene(winner, loser){
  const name = esc(S.names[loser]);
  document.body.insertAdjacentHTML("beforeend", `
    <div class="cinema" id="cinema">
      <button class="skip" id="skip">スキップ ≫</button>
      <div class="vignette" id="vig"></div>
      <div id="lines" style="z-index:5">
        <div class="cine-line" id="l1">―― 全4ゲーム、終了。</div>
        <div class="cine-line" id="l2">${name}…… 精算の、お時間です。</div>
        <div class="cine-line red" id="l3">「借りたものは、返してもらう」</div>
      </div>
      <div class="alley"></div>
      <div class="headlight" id="hl"></div>
      <div class="car" id="car">🚘</div>
      <div class="goons" id="goons">🕴️🕴️🕴️</div>
      <div class="victim" id="victim">😨</div>
      <div class="fin" id="fin">回 収 完 了</div>
    </div>
  `);
  const $ = id=>document.getElementById(id);
  const timeouts = [];
  const at = (ms, fn)=>timeouts.push(setTimeout(fn, ms));
  const end = ()=>{
    timeouts.forEach(clearTimeout);
    const c = $("cinema"); if(c) c.remove();
    epilogue(winner, loser);
  };
  $("skip").onclick = end;
  at(500,  ()=>$("l1").classList.add("on"));
  at(2200, ()=>{ $("hl").classList.add("on"); $("car").classList.add("arrive"); });
  at(4000, ()=>{ $("goons").classList.add("walk"); $("l2").classList.add("on"); });
  at(7200, ()=>{ $("l3").classList.add("on"); $("vig").classList.add("on"); $("cinema").classList.add("shake"); $("victim").classList.add("grabbed"); });
  at(9200, ()=>{ $("cinema").classList.remove("shake"); $("victim").classList.remove("grabbed"); $("victim").classList.add("taken"); $("goons").classList.remove("walk"); });
  at(10800,()=>{ $("car").classList.remove("arrive"); $("car").classList.add("leave"); });
  at(12500,()=>{ $("lines").style.opacity = 0; $("fin").classList.add("on"); });
  at(15000, end);
}

function epilogue(winner, loser){
  const skillCell = (i)=> S.p[i].usedSkill ? SKILLS[S.p[i].usedSkill].name : "未使用";
  show(`
    <h1 style="font-size:26px">結果発表</h1>
    <div class="card center">
      <div class="big">🏆 <span class="${pcls(winner)}">${esc(S.names[winner])}</span> の勝利</div>
      <p class="note">${esc(S.names[winner])} は100万円を返済し、生還した。</p>
      <hr class="sep">
      <p style="color:var(--red)">${esc(S.names[loser])} は黒塗りの車で連れて行かれました……。<br>
      <span class="note">行き先を知る者はいない。</span></p>
    </div>
    <div class="card">
      <table class="res">
        <tr><th></th><th class="p1c">${esc(S.names[0])}</th><th class="p2c">${esc(S.names[1])}</th></tr>
        <tr><td><b>最終勝ち点</b></td><td><b>${fmtPts(S.p[0].pts)}</b></td><td><b>${fmtPts(S.p[1].pts)}</b></td></tr>
        <tr><td>残金</td><td>${fmtMan(S.p[0].cash)}</td><td>${fmtMan(S.p[1].cash)}</td></tr>
        <tr><td>使用スキル</td><td>${skillCell(0)}</td><td>${skillCell(1)}</td></tr>
      </table>
    </div>
    ${isOnline() ? `<p class="note center">オンライン対戦をもう一度遊ぶには、部屋を作り直してください。</p>` : ""}
    <button class="btn" id="ok">もう一度遊ぶ</button>
  `);
  document.getElementById("ok").onclick = ()=>location.reload();
}

titleScreen();
