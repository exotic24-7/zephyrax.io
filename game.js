// --- game.js ---
const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d");


// Run equip hooks for all currently equipped items (best-effort idempotent sync)
function runEquipHooks(){
    try{
        for(let i=0;i<10;i++){
            if(player.equipped[i] && player.equipped[i].type) applyOnEquip(i, false);
            if(player.swap[i] && player.swap[i].type) applyOnEquip(i, true);
        }
    }catch(e){}
}

let CENTER_X = canvas.width/2;
let CENTER_Y = canvas.height/2;
let viewWidth = canvas.width;
let viewHeight = canvas.height;

/* =========================
   CANVAS SCALE & COLLISION FIX
   ========================= */
// FORCE 1:1 coordinate system (NO CSS scaling)
function resizeCanvas(){
    const scale = window.devicePixelRatio || 1;
    // Match canvas resolution to displayed size
    let rect = canvas.getBoundingClientRect();
    // If the canvas has no layout size (hidden or not yet in DOM), fallback to window size
    if(!rect.width || !rect.height){
        rect = { width: window.innerWidth || 800, height: window.innerHeight || 600, left: 0, top: 0 };
    }
    canvas.width  = Math.floor(rect.width  * scale);
    canvas.height = Math.floor(rect.height * scale);
    // apply transform so drawing uses CSS pixels
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    // update center variables (in CSS pixels)
    CENTER_X = rect.width/2;
    CENTER_Y = rect.height/2;
    viewWidth = rect.width;
    viewHeight = rect.height;
    // ensure the element's CSS size matches the logical view
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
}
// Run once and on resize
resizeCanvas();
window.addEventListener('resize', resizeCanvas);

let keys = {};
document.addEventListener("keydown", e => keys[e.key] = true);
document.addEventListener("keyup", e => keys[e.key] = false);

// collision debug toggle
window.COLLISION_DEBUG = false;
// verbose collision logs (disable to avoid console spam)
window.COLLISION_LOGS = false;

// small throttled logger to avoid console spam for repeated collision messages
window._lastLogTimes = window._lastLogTimes || {};
function throttleLog(key, fn, minMs = 250){
    try{
        const now = Date.now();
        const last = window._lastLogTimes[key] || 0;
        if(now - last > minMs){ fn(); window._lastLogTimes[key] = now; }
    }catch(e){ /* ignore logging failures */ }
}

// control mode: 'keyboard' or 'mouse'
let controlMode = localStorage.getItem('controlMode') || 'keyboard';
window.setControlMode = function(mode){ controlMode = mode; localStorage.setItem('controlMode', mode); };

// show hitboxes toggle
let showHitboxes = (localStorage.getItem('showHitboxes') === '1');
window.setShowHitboxes = function(v){ showHitboxes = !!v; localStorage.setItem('showHitboxes', showHitboxes ? '1' : '0'); };

// Keyboard toggles for UI (will call DOM modal toggles)
document.addEventListener("keydown", e => {
    if(typeof e.key === 'string'){
        const k = e.key.toLowerCase();
        if(k === 'x' && window.toggleInventory) window.toggleInventory();
        if(k === 'c' && window.toggleCraft) window.toggleCraft();
        if(k === 'v' && window.toggleSeen) window.toggleSeen();
    }
});

// --- PLAYER ---
let player = { x:CENTER_X, y:CENTER_Y, radius:15, speed:4, health:100, maxHealth:100, petals:10, petalsDistance:30, inventory:[], equipped:Array(10).fill(null), cooldowns:{}, mass: 10, vx:0, vy:0 };
// separate swap row storage (user-visible second row)
player.swap = Array(10).fill(null);
// store default and expanded distances for smooth transitions
player.petalsDistanceDefault = 30;
player.petalsDistanceExpanded = 80;
// track seen mobs and allow inventory stacking by type+rarity
player.seenMobs = {};
let petals = [];
function refreshPetals(){
    petals = [];
    for(let i=0;i<player.petals;i++){
        petals.push({angle:(Math.PI*2/player.petals)*i,radius:6, slotIndex: i});
    }
}

// Passive effects for equipped petals (per-slot cooldowns)
function applyPassiveEffects(){
    const now = Date.now();
    for(let i=0;i<player.equipped.length;i++){
        const slot = player.equipped[i]; if(!slot) continue;
        const type = slot.type;
        const key = 'passive_' + i;
        if(type === 'Rose'){
            // small heal every 1000ms
            if(!player.cooldowns[key] || now - player.cooldowns[key] >= 1000){ player.health = Math.min(player.maxHealth, player.health + 2); player.cooldowns[key] = now; }
        } else if(type === 'Pollen'){
            // aura damage to nearby mobs every 600ms
            if(!player.cooldowns[key] || now - player.cooldowns[key] >= 600){
                mobs.forEach(mob=>{ const d=Math.hypot(mob.x-player.x,mob.y-player.y); if(d < player.petalsDistance+20) mob.health -= 2; });
                player.cooldowns[key] = now;
            }
        }
    }
}
refreshPetals();
// track last time player was hit for i-frames
player.lastHitTime = 0;

// --- GAME STATE ---
let mobs=[];
let drops=[];
let projectiles=[];
let currentWave=1;
let isDead=false;
let spaceHeld = false;
let mouseHeld = false;
let animationId = null;
let nextEquipIndex = 0;

// ---- GLOBAL COOLDOWNS ----
const PETAL_HIT_COOLDOWN = 350; // ms between petal hits per mob
const PLAYER_IFRAME_TIME = 500; // ms of invincibility after hit

// --- ITEMS ---
const ITEM_TYPES={
    Rose:{name:"Rose",heal:15,cooldown:1000,useTime:1000, mass:0.2},
    Light:{name:"Light",damage:5,cooldown:700,useTime:700, mass:0.3},
    Stinger:{name:"Stinger",damage:20,cooldown:5000,useTime:5000, mass:0.7},
    Pollen:{name:"Pollen",damage:3,cooldown:1200,useTime:300, mass:0.25},
    Missile:{name:"Missile",damage:10,cooldown:1200,useTime:400, mass:1.0}
};

function spawnDrop(name,x,y){ drops.push({x,y,radius:8,type:name,stack:1}); }
function spawnMobDrops(mob){
    // data-driven drops if CONFIG available
    try{
        if(typeof window !== 'undefined' && window.ZEPHYRAX_CONFIG){
            const tpl = window.ZEPHYRAX_CONFIG.mobs.find(m=>m.id===mob.type || m.name===mob.name);
            if(tpl && tpl.drops && tpl.drops.length>0){
                tpl.drops.forEach((d,idx)=> spawnDrop(d, mob.x + (idx*8), mob.y + (idx*8)));
                return;
            }
        }
    }catch(e){}
    // fallback
    switch(mob.type){
        case "Ladybug": spawnDrop("Rose",mob.x,mob.y); spawnDrop("Light",mob.x+15,mob.y+15); break;
        case "Bee": spawnDrop("Stinger",mob.x,mob.y); spawnDrop("Pollen",mob.x+15,mob.y+15); break;
        case "Hornet": spawnDrop("Missile",mob.x,mob.y); break;
    }
}

// helper to add inventory entries (type,rarity,stack)
function addToInventory(type,rarity,amount){
    amount = amount || 1;
    let found = player.inventory.find(it=>it.type===type && it.rarity===rarity);
    if(found) found.stack += amount; else player.inventory.push({type,rarity,stack:amount});
    try{ savePlayerState(); }catch(e){}
}

// ----- Petal definitions loader and equip hooks -----
window.PETAL_DEFS = {};
window.PETAL_HOOKS = window.PETAL_HOOKS || {};
function loadPetalDefs(){
    // try fetching JSON definitions; if failure, fallback to empty
    fetch('data/petals.json').then(r=>r.json()).then(list=>{
        list.forEach(p=>{ window.PETAL_DEFS[p.name || p.id] = p; window.PETAL_DEFS[p.id || p.name] = p; });
        // also index by lowercase
        list.forEach(p=>{ if(p.name) window.PETAL_DEFS[p.name.toLowerCase()] = p; if(p.id) window.PETAL_DEFS[p.id.toLowerCase()] = p; });
    }).catch(()=>{
        // ignore failures; game will still function with textual names
    });
}
loadPetalDefs();

// Simple SVG icon generator for petals (data URL cache)
const PETAL_ICON_CACHE = {};
function getPetalIconURL(type, rarity, size=40){
    const key = `${type}|${rarity}|${size}`;
    if(PETAL_ICON_CACHE[key]) return PETAL_ICON_CACHE[key];
    const def = window.PETAL_DEFS[type] || window.PETAL_DEFS[(type||'').toLowerCase()] || {};
    const fill = def.color || RARITY_COLOR[rarity] || '#d0d0d0';
    const stroke = '#111';
    const t = (type||'').toLowerCase();
    let shape = 'circle';
    if(t.includes('leaf') || t.includes('leafy') || t.includes('peas') || t.includes('clover')) shape = 'leaf';
    else if(t.includes('stinger') || t.includes('thorn') || t.includes('spike')) shape = 'spike';
    else if(t.includes('honey') || t.includes('wax') || t.includes('bee')) shape = 'hex';
    else if(t.includes('glass') || t.includes('rock') || t.includes('stone')) shape = 'diamond';
    else if(t.includes('rose') || t.includes('flower') || t.includes('basil')) shape = 'flower';
    else if(t.includes('light') || t.includes('glow')) shape = 'glow';

    const w = size, h = size;
    let svg = '';
    if(shape === 'circle' || shape === 'glow'){
        const g = shape==='glow' ? `<radialGradient id='g'><stop offset='0%' stop-color='${fill}' stop-opacity='1'/><stop offset='80%' stop-color='${fill}' stop-opacity='0.55'/></radialGradient>` : '';
        svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}' viewBox='0 0 ${w} ${h}'>${g}<rect width='100%' height='100%' fill='transparent'/>${shape==='glow'?`<circle cx='${w/2}' cy='${h/2}' r='${w*0.38}' fill='url(#g)' stroke='${stroke}' stroke-width='1'/>`:`<circle cx='${w/2}' cy='${h/2}' r='${w*0.36}' fill='${fill}' stroke='${stroke}' stroke-width='1'/>`}<text x='50%' y='55%' font-size='12' text-anchor='middle' fill='#ffffff' font-family='Arial' font-weight='700'>${(type||'')[0]||''}</text></svg>`;
    } else if(shape === 'hex'){
        const cx=w/2, cy=h/2, r=w*0.34; const pts=[]; for(let i=0;i<6;i++){ const a = Math.PI/3 * i - Math.PI/6; pts.push((cx+Math.cos(a)*r).toFixed(2)+','+(cy+Math.sin(a)*r).toFixed(2)); }
        svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}' viewBox='0 0 ${w} ${h}'><polygon points='${pts.join(' ')}' fill='${fill}' stroke='${stroke}' stroke-width='1'/><text x='50%' y='58%' font-size='12' text-anchor='middle' fill='#fff' font-family='Arial' font-weight='700'>${(type||'')[0]||''}</text></svg>`;
    } else if(shape === 'diamond'){
        const pts = `${w/2},${h*0.15} ${w*0.85},${h/2} ${w/2},${h*0.85} ${w*0.15},${h/2}`;
        svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}' viewBox='0 0 ${w} ${h}'><polygon points='${pts}' fill='${fill}' stroke='${stroke}' stroke-width='1'/></svg>`;
    } else if(shape === 'leaf'){
        svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}' viewBox='0 0 ${w} ${h}'><path d='M${w*0.2},${h*0.6} C${w*0.25},${h*0.2} ${w*0.6},${h*0.2} ${w*0.8},${h*0.35} C${w*0.65},${h*0.65} ${w*0.35},${h*0.9} ${w*0.2},${h*0.6} Z' fill='${fill}' stroke='${stroke}' stroke-width='1'/></svg>`;
    } else if(shape === 'flower'){
        // simple 5-petal flower
        const cx=w/2, cy=h/2; svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}' viewBox='0 0 ${w} ${h}'>`;
        for(let i=0;i<5;i++){ const a = (Math.PI*2/5)*i; const px=cx+Math.cos(a)*(w*0.26); const py=cy+Math.sin(a)*(h*0.26); svg += `<ellipse cx='${px}' cy='${py}' rx='${w*0.16}' ry='${h*0.12}' fill='${fill}' stroke='${stroke}' stroke-width='0.6' transform='rotate(${(a*180/Math.PI)} ${px} ${py})'/>`; }
        svg += `<circle cx='${cx}' cy='${cy}' r='${w*0.12}' fill='#fff'/>`;
        svg += `</svg>`;
    } else if(shape === 'spike'){
        // star-like
        const cx=w/2, cy=h/2; let pts=''; for(let i=0;i<8;i++){ const r = (i%2==0)?w*0.38:w*0.16; const a = (Math.PI*2/8)*i - Math.PI/2; pts += (cx+Math.cos(a)*r).toFixed(2)+','+(cy+Math.sin(a)*r).toFixed(2)+' '; }
        svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}' viewBox='0 0 ${w} ${h}'><polygon points='${pts.trim()}' fill='${fill}' stroke='${stroke}' stroke-width='0.8'/></svg>`;
    }
    const data = 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
    PETAL_ICON_CACHE[key] = data;
    return data;
}

// Create a floating tooltip element for petal stats/descriptions
function ensurePetalTooltip(){
    if(window._petalTooltipCreated) return;
    window._petalTooltipCreated = true;
    function make(){
        const el = document.createElement('div');
        el.id = 'petalTooltip';
        el.style.position = 'fixed';
        el.style.pointerEvents = 'none';
        el.style.zIndex = 99999;
        el.style.padding = '8px 10px';
        el.style.background = 'rgba(12,12,16,0.94)';
        el.style.color = 'white';
        el.style.borderRadius = '8px';
        el.style.boxShadow = '0 6px 18px rgba(0,0,0,0.6)';
        el.style.fontSize = '13px';
        el.style.lineHeight = '1.2';
        el.style.maxWidth = '320px';
        el.style.display = 'none';
        document.body.appendChild(el);
        window._petalTooltipEl = el;
    }
    if(document.body) make(); else document.addEventListener('DOMContentLoaded', make);

    let currentTarget = null;
    document.addEventListener('pointerover', function(ev){
        try{
            const t = ev.target.closest && ev.target.closest('[data-type]');
            if(!t) return;
            const type = t.dataset.type;
            if(!type) return;
            currentTarget = t;
            const rarity = t.dataset.rarity || 'Common';
            const def = window.PETAL_DEFS && (window.PETAL_DEFS[type] || window.PETAL_DEFS[type.toLowerCase()]) ? (window.PETAL_DEFS[type] || window.PETAL_DEFS[type.toLowerCase()]) : null;
            const title = def && (def.name || def.id) ? (def.name || def.id) : (type || 'Unknown');
            const desc = def && def.description ? def.description : '';
            const bp = def && (def.basePower || def.power) ? (`<div style="margin-top:6px;color:#ddd;font-size:12px">Power: <strong style='color:#fff'>${def.basePower || def.power}</strong></div>`) : '';
            const typ = def && def.type ? (`<div style="margin-top:4px;color:#ccc;font-size:12px">Type: ${def.type}</div>`) : '';
            const rarityColor = RARITY_COLOR[rarity] || '#ddd';
            const html = `<div style="font-weight:700;margin-bottom:4px;display:flex;align-items:center;justify-content:space-between"><div>${title}</div><div style='font-size:11px;padding:2px 6px;border-radius:6px;background:${rarityColor};color:${contrastColor(rarityColor)}'>${rarity}</div></div><div style="color:#ddd;font-size:13px">${desc}</div>${typ}${bp}`;
            if(window._petalTooltipEl){ window._petalTooltipEl.innerHTML = html; window._petalTooltipEl.style.display = 'block'; }
        }catch(e){}
    });

    document.addEventListener('pointermove', function(ev){
        try{
            if(!window._petalTooltipEl || !currentTarget) return;
            const pad = 12;
            let x = ev.clientX + pad;
            let y = ev.clientY + pad;
            const w = window._petalTooltipEl.offsetWidth;
            const h = window._petalTooltipEl.offsetHeight;
            if(x + w > window.innerWidth) x = Math.max(8, ev.clientX - w - pad);
            if(y + h > window.innerHeight) y = Math.max(8, ev.clientY - h - pad);
            window._petalTooltipEl.style.left = x + 'px'; window._petalTooltipEl.style.top = y + 'px';
        }catch(e){}
    });

    document.addEventListener('pointerout', function(ev){
        try{
            const left = ev.target.closest && ev.target.closest('[data-type]');
            if(!left) return;
            if(window._petalTooltipEl){ window._petalTooltipEl.style.display = 'none'; }
            currentTarget = null;
        }catch(e){}
    });
}
ensurePetalTooltip();

function applyOnEquip(slotIndex, isSwap){
    const arr = isSwap ? player.swap : player.equipped;
    const s = arr[slotIndex];
    if(!s || !s.type) return;
    const def = window.PETAL_DEFS[s.type] || window.PETAL_DEFS[(s.type||'').toLowerCase()];
    if(def && def.onEquip && typeof window.PETAL_HOOKS[def.onEquip] === 'function'){
        try{ window.PETAL_HOOKS[def.onEquip](slotIndex, s); }catch(e){}
    }
}

function applyOnUnequip(slotIndex, isSwap){
    const arr = isSwap ? player.swap : player.equipped;
    const s = arr[slotIndex];
    // when unequipping we may want to run remove hooks — placeholder
    if(!s) return;
    const def = window.PETAL_DEFS[s.type] || window.PETAL_DEFS[(s.type||'').toLowerCase()];
    if(def && def.onUnequip && typeof window.PETAL_HOOKS[def.onUnequip] === 'function'){
        try{ window.PETAL_HOOKS[def.onUnequip](slotIndex, s); }catch(e){}
    }
}

// Persist inventory and equipped state so items don't disappear after death or reload
function savePlayerState(){
    try{
        const state = { inventory: player.inventory, equipped: player.equipped, swap: player.swap };
        localStorage.setItem('zephyrax_player_state', JSON.stringify(state));
    }catch(e){}
}
function loadPlayerState(){
    try{
        const raw = localStorage.getItem('zephyrax_player_state');
        if(!raw) return;
        const state = JSON.parse(raw);
        if(state.inventory && Array.isArray(state.inventory)) player.inventory = state.inventory;
        if(state.equipped && Array.isArray(state.equipped)) player.equipped = state.equipped;
        if(state.swap && Array.isArray(state.swap)) player.swap = state.swap;
    }catch(e){}
}
// load on script start
loadPlayerState();

// --- SPAWN WAVE ---
function spawnWave(waveNumber){
    mobs = [];
    const cfg = (typeof window !== 'undefined' && window.ZEPHYRAX_CONFIG) ? window.ZEPHYRAX_CONFIG : null;
    const count = Math.max(3, 6 + Math.floor(waveNumber * 1.2));
    for(let i=0;i<count;i++){
        const scale = window.devicePixelRatio || 1;
        let x=Math.random()*viewWidth;
        let y=Math.random()*viewHeight;
        if(cfg && cfg.mobs && cfg.mobs.length){
                const tpl = cfg.mobs[Math.floor(Math.random()*cfg.mobs.length)];
            // determine rarity index (baseRarity from template optional, plus slow wave scaling)
                const maxR = (cfg.rarities && cfg.rarities.length) ? cfg.rarities.length - 1 : (RARITY_NAMES.length - 1);
                let base = Math.max(0, tpl.baseRarity || 0);
                // pick rarity based on configured spawn table for this wave
                let rarityName = pickRarityByWave(waveNumber);
                let rarityIndex = RARITY_NAMES.indexOf(rarityName);
                if(rarityIndex < 0) rarityIndex = Math.min(base + Math.floor(waveNumber/10), maxR);
                // allow template to bias upward
                if(base) rarityIndex = Math.max(rarityIndex, base);
            // if config provides explicit multiplier objects, use them; otherwise compute multiplier from index
            let multiplier = 1;
            let rarityName = 'Common';
            if(cfg.rarities && cfg.rarities[rarityIndex]){
                multiplier = cfg.rarities[rarityIndex].multiplier || rarityMultiplier(rarityIndex);
                rarityName = cfg.rarities[rarityIndex].name || RARITY_NAMES[rarityIndex] || 'Common';
            } else {
                multiplier = rarityMultiplier(rarityIndex);
                rarityName = RARITY_NAMES[rarityIndex] || 'Common';
            }
            const hp = Math.max(6, Math.round((tpl.baseHP||30) * multiplier * (1 + waveNumber*0.03)));
            const dmg = Math.max(1, Math.round((tpl.baseDamage||2) * multiplier));
            const size = Math.max(8, Math.round((tpl.baseSize||12) * (1 + rarityIndex*0.07)));
            const speed = Math.max(0.2, (tpl.baseSpeed? tpl.baseSpeed : Math.max(0.6, 1.6 - (rarityIndex*0.04))));
            const typeVal = (tpl.id || tpl.name || '').toString();
            const shootCd = (tpl.shootCooldown != null) ? tpl.shootCooldown : ((typeVal.toLowerCase() === 'hornet') ? 120 : 0);
            mobs.push({x,y,radius:size,speed:speed,health:hp,maxHealth:hp,name:tpl.name,type:typeVal,projectiles:[],shootCooldown: shootCd,rarityIndex:rarityIndex,rarityName:rarityName,stationary:!!tpl.stationary, mass: Math.max(1, Math.round(size * (1 + rarityIndex*0.06))), vx:0, vy:0});
        } else {
            // fallback older behavior with rarity chosen from the spawn table
            let choice=Math.random();
            const rName = pickRarityByWave(waveNumber);
            const rarityIndex = Math.max(0, Math.min(RARITY_NAMES.indexOf(rName), RARITY_NAMES.length-1));
            const mult = rarityMultiplier(rarityIndex);
            if(choice<0.25) mobs.push({x,y,radius:Math.round(12 * (1 + rarityIndex*0.06)),speed:Math.max(0.2,1.5/(Math.max(1,mult*0.8))),health:Math.round(50*mult),maxHealth:Math.round(50*mult),name:"Ladybug",type:"Ladybug",projectiles:[],rarityIndex:rarityIndex,rarityName:rName,stationary:false, mass: Math.round(12 * (1 + rarityIndex*0.06)), vx:0, vy:0});
            else if(choice<0.5) mobs.push({x,y,radius:Math.round(10 * (1 + rarityIndex*0.06)),speed:Math.max(0.2,2/(Math.max(1,mult*0.8))),health:Math.round(30*mult),maxHealth:Math.round(30*mult),name:"Bee",type:"Bee",projectiles:[],rarityIndex:rarityIndex,rarityName:rName,stationary:false, mass: Math.round(10 * (1 + rarityIndex*0.06)), vx:0, vy:0});
            else if(choice<0.75) mobs.push({x,y,radius:Math.round(12 * (1 + rarityIndex*0.06)),speed:Math.max(0.2,1.2/(Math.max(1,mult*0.8))),health:Math.round(40*mult),maxHealth:Math.round(40*mult),name:"Hornet",type:"Hornet",projectiles:[],shootCooldown:120,rarityIndex:rarityIndex,rarityName:rName,stationary:false, mass: Math.round(12 * (1 + rarityIndex*0.06)), vx:0, vy:0});
            else mobs.push({x,y,radius:Math.round(18 * (1 + rarityIndex*0.06)),speed:0,health:Math.round(30*mult),maxHealth:Math.round(30*mult),name:"Dandelion",type:"Dandelion",projectiles:[],rarityIndex:rarityIndex,rarityName:rName,stationary:true, mass: Math.round(18 * (1 + rarityIndex*0.06)), vx:0, vy:0});
        }
    }
}

// update & draw player projectiles
function updateProjectiles(){
    for(let i=projectiles.length-1;i>=0;i--){
        const p = projectiles[i];
        p.x += p.dx; p.y += p.dy;
        // remove off-screen
        if(p.x < -50 || p.x > viewWidth+50 || p.y < -50 || p.y > viewHeight+50){ projectiles.splice(i,1); }
    }
}

function drawProjectiles(){
    projectiles.forEach(p=>{
        ctx.fillStyle = (p.type==='Missile')? 'grey' : 'white';
        ctx.beginPath(); ctx.arc(p.x,p.y,p.radius||4,0,Math.PI*2); ctx.fill();
        if(showHitboxes){ ctx.strokeStyle='red'; ctx.lineWidth=1; ctx.beginPath(); ctx.arc(p.x,p.y,p.radius||4,0,Math.PI*2); ctx.stroke(); }
    });
}

// --- PLAYER MOVEMENT ---
function movePlayer(){
    if(isDead) return;
    if(controlMode === 'mouse'){
        // follow mouse smoothly
        const dx = mouseX - player.x; const dy = mouseY - player.y; const dist = Math.hypot(dx,dy);
        if(dist > 2){ player.x += (dx/dist) * Math.min(player.speed, dist); player.y += (dy/dist) * Math.min(player.speed, dist); }
        return;
    }
    if(keys["ArrowUp"]) player.y-=player.speed;
    if(keys["ArrowDown"]) player.y+=player.speed;
    if(keys["ArrowLeft"]) player.x-=player.speed;
    if(keys["ArrowRight"]) player.x+=player.speed;
    player.x=Math.max(player.radius,Math.min(viewWidth-player.radius,player.x));
    player.y=Math.max(player.radius,Math.min(viewHeight-player.radius,player.y));
}

// --- PETALS ---
function updatePetals(){ if(!isDead) petals.forEach(p=>p.angle+=0.05); }

// Smoothly move petal distance toward target depending on hold state
function updatePetalDistance(){
    if(spaceHeld || mouseHeld){
        // immediate expand for responsiveness
        player.petalsDistance = player.petalsDistanceExpanded;
        return;
    }
    const target = player.petalsDistanceDefault;
    // lerp back faster
    player.petalsDistance += (target - player.petalsDistance) * 0.6;
}

// --- MOB MOVEMENT ---
function moveMobs(){
    if(isDead) return;
    mobs.forEach(mob=>{
        if(mob.stationary){
            // stationary mobs do not move, but their projectiles should still update
            if(mob.projectiles && mob.projectiles.length){ for(let i=0;i<mob.projectiles.length;i++){ const p = mob.projectiles[i]; p.x += p.dx; p.y += p.dy; } }
            return;
        }

        const t = (mob.type || mob.name || '').toString().toLowerCase();
        if(t === "hornet"){
            // Hornets maintain distance and shoot
            let dx = player.x - mob.x;
            let dy = player.y - mob.y;
            let dist = Math.hypot(dx,dy);
            let desiredDist = 200;
            if(dist>desiredDist){
                mob.x += (dx/dist)*mob.speed;
                mob.y += (dy/dist)*mob.speed;
            } else if(dist<desiredDist-50){
                mob.x -= (dx/dist)*mob.speed;
                mob.y -= (dy/dist)*mob.speed;
            }

            // Shooting cooldown
            mob.shootCooldown = (mob.shootCooldown==null)?120:mob.shootCooldown - 1;
            if(mob.shootCooldown <= 0){
                let angle = Math.atan2(player.y-mob.y, player.x-mob.x);
                mob.projectiles.push({x:mob.x,y:mob.y,dx:Math.cos(angle)*4,dy:Math.sin(angle)*4,radius:5,type:"Missile",damage:5});
                mob.shootCooldown = 120; // frames cooldown
            }
        } else { 
            // Ladybug & Bee chase player
            let dx = player.x - mob.x;
            let dy = player.y - mob.y;
            let dist = Math.hypot(dx,dy);
            if(dist>0){ mob.x += (dx/dist)*mob.speed; mob.y += (dy/dist)*mob.speed; }
        }

        // Move mob projectiles
        if(mob.projectiles && mob.projectiles.length){ for(let i=0;i<mob.projectiles.length;i++){ const p = mob.projectiles[i]; p.x += p.dx; p.y += p.dy; } }

        // apply velocity from external impulses (knockback) and damp it
        if(typeof mob.vx === 'number' && typeof mob.vy === 'number'){
            mob.x += mob.vx; mob.y += mob.vy;
            mob.vx *= 0.86; mob.vy *= 0.86;
            // small clamp so they don't drift infinitely
            if(Math.abs(mob.vx) < 0.01) mob.vx = 0;
            if(Math.abs(mob.vy) < 0.01) mob.vy = 0;
        }
    });

    // MOB ↔ MOB collision resolution (pairwise)
    for(let i=0;i<mobs.length;i++){
        for(let j=i+1;j<mobs.length;j++){
            const a = mobs[i];
            const b = mobs[j];
            const dx = b.x - a.x; const dy = b.y - a.y;
            const dist = Math.hypot(dx,dy);
            const minDist = (a.radius || 0) + (b.radius || 0);
            if(dist > 0 && dist < minDist){
                const overlap = minDist - dist;
                const nx = dx / dist; const ny = dy / dist;
                const am = a.mass || 1; const bm = b.mass || 1;
                const total = am + bm;
                // positional correction (separate them based on mass)
                const aMove = overlap * (bm / total) * 0.6;
                const bMove = overlap * (am / total) * 0.6;
                a.x -= nx * aMove; a.y -= ny * aMove;
                b.x += nx * bMove; b.y += ny * bMove;
                // convert overlap into velocity impulse
                const impulse = Math.max(0.6, overlap * 0.8);
                a.vx = (a.vx || 0) - nx * (impulse * (bm/total));
                a.vy = (a.vy || 0) - ny * (impulse * (bm/total));
                b.vx = (b.vx || 0) + nx * (impulse * (am/total));
                b.vy = (b.vy || 0) + ny * (impulse * (am/total));
            }
        }
    }
}

// Track mouse position for aiming
let mouseX = CENTER_X, mouseY = CENTER_Y;
canvas.addEventListener('mousemove', function(e){
    const r = canvas.getBoundingClientRect();
    mouseX = e.clientX - r.left; mouseY = e.clientY - r.top;
});

// Attack: when player clicks on canvas, trigger on-attack petal effects
function performAttack(targetX, targetY){
    if(isDead) return;
    for(let i=0;i<player.equipped.length;i++){
        const slot = player.equipped[i];
        if(!slot) continue;
        const base = ITEM_TYPES[slot.type] || null;
        // define which items trigger on-attack
        const onAttackTypes = { Light: true, Missile: true, Stinger: true };
        if(!onAttackTypes[slot.type]) continue;
        // per-slot cooldown so multiple same-type equips can fire independently
        const now = Date.now();
        const cdKey = 'slot_' + i;
        const cooldown = base ? base.cooldown : 800;
        if(player.cooldowns[cdKey] && now - player.cooldowns[cdKey] < cooldown) continue;

        // compute petal position for this slot (use corresponding petal if exists)
        const petal = petals[i % petals.length];
        let sx = player.x, sy = player.y;
        if(petal){ sx = player.x + Math.cos(petal.angle) * player.petalsDistance; sy = player.y + Math.sin(petal.angle) * player.petalsDistance; }

        // spawn projectile towards target and expand corresponding petal
        const angle = Math.atan2(targetY - sy, targetX - sx);
        const damage = base ? base.damage : 1;
        projectiles.push({x: sx, y: sy, dx: Math.cos(angle)*6, dy: Math.sin(angle)*6, radius:6, type: slot.type, damage: damage});
        player.cooldowns[cdKey] = now;
        // animate petal outward briefly
        if(petal){ petal.expandUntil = Date.now() + 220; petal.expandExtra = 48; }
        // decrement stack but keep slot object (mark empty) so petal remains
        slot.stack = (slot.stack || 1) - 1;
        if(slot.stack <= 0){ slot.stack = 0; slot.empty = true; }
    }
    // refresh inventory UI
    if(window.renderInventory) window.renderInventory();
}

canvas.addEventListener('mousedown', function(e){
    if(e.button !== 0) return;
    // ensure clicks outside UI only (canvas captures anyway)
    const r = canvas.getBoundingClientRect();
    const tx = e.clientX - r.left; const ty = e.clientY - r.top;
    performAttack(tx, ty);
});

// --- COLLISIONS ---
function checkCollisions(){
    if(isDead) return;

    // clear per-frame debug flags
    player._debug = false;
    mobs.forEach(m=>{ m._debug = false; });

    for(let mi = mobs.length - 1; mi >= 0; mi--){
        const mob = mobs[mi];

        /* --- Player ↔ Mob collision (with i-frames) --- */
        const distPM = Math.hypot(player.x - mob.x, player.y - mob.y);
        if(distPM < player.radius + mob.radius){
            // mark debug flag so drawMobs can highlight
            mob._debug = true;
            player._debug = true;
            const now = Date.now();
            // apply separation / mass-based knockback regardless of i-frames so collisions push apart
            const overlap = (player.radius + mob.radius) - distPM;
            if(distPM > 0 && overlap > 0){
                const nx = (player.x - mob.x) / distPM;
                const ny = (player.y - mob.y) / distPM;
                const total = Math.max(0.0001, (player.mass || 1) + (mob.mass || 1));
                const push = overlap * 0.6;
                // lighter objects move more: displacement inversely proportional to mass
                const pMove = push * ((mob.mass || 1) / total);
                const mMove = push * ((player.mass || 1) / total);
                player.x += nx * pMove; player.y += ny * pMove;
                mob.x -= nx * mMove; mob.y -= ny * mMove;
                // convert into velocities
                player.vx = (player.vx || 0) + nx * ((mob.mass || 1) / total) * 1.6;
                player.vy = (player.vy || 0) + ny * ((mob.mass || 1) / total) * 1.6;
                mob.vx = (mob.vx || 0) - nx * ((player.mass || 1) / total) * 1.6;
                mob.vy = (mob.vy || 0) - ny * ((player.mass || 1) / total) * 1.6;
            }

            if(now - player.lastHitTime > PLAYER_IFRAME_TIME){
                const t = (mob.type || mob.name || '').toString().toLowerCase();
                player.health -= (t === 'bee') ? 1 : 0.5;
                player._hitFlash = Date.now();
                if(window.COLLISION_LOGS) console.log('PLAYER HIT by', mob.name || mob.type, 'hp=', player.health, 'dist=', distPM.toFixed(1), 'thresh=', (player.radius+mob.radius).toFixed(1));
                player.lastHitTime = now;
            } else if(window.COLLISION_DEBUG){
                throttleLog('collision-iframe', ()=> console.log('Collision detected but in i-frame. dist=', distPM.toFixed(1)), 400);
            }
        } else if(window.COLLISION_DEBUG && distPM < 300){
            // nearby debug info
            throttleLog('collision-near-'+(mob.name||mob.type), ()=> console.log('NEAR: mob=', mob.name||mob.type, 'dist=', distPM.toFixed(1), 'thresh=', (player.radius+mob.radius).toFixed(1)), 600);
        }

        /* --- Petals ↔ Mob collision (cooldown based) --- */
        mob.lastPetalHit = mob.lastPetalHit || {};
        for(let pi = 0; pi < petals.length; pi++){
            const p = petals[pi];
            const px = player.x + Math.cos(p.angle) * player.petalsDistance;
            const py = player.y + Math.sin(p.angle) * player.petalsDistance;
            const distPetal = Math.hypot(px - mob.x, py - mob.y);

            if(distPetal < (p.radius || 6) + mob.radius){
                const key = `petal_${pi}`;
                const now = Date.now();
                if(!mob.lastPetalHit[key] || now - mob.lastPetalHit[key] > PETAL_HIT_COOLDOWN){
                    mob.health -= 0.5;
                    mob._hitFlash = Date.now();
                    if(window.COLLISION_LOGS) throttleLog('mob-petal-'+(mob.name||mob.type), ()=> console.log('MOB HIT by petal', mob.name || mob.type, 'hp=', mob.health), 80);
                    mob.lastPetalHit[key] = now;
                }
            }
        }

        /* --- Mob projectiles ↔ Player --- */
        if(mob.projectiles){
            for(let pi = mob.projectiles.length - 1; pi >= 0; pi--){
                const p = mob.projectiles[pi];
                const d = Math.hypot(player.x - p.x, player.y - p.y);
                if(d < player.radius + (p.radius || 4)){
                    player.health -= (p.damage || 1);
                    player._hitFlash = Date.now();
                    if(window.COLLISION_LOGS) throttleLog('player-proj-'+(p.type||''), ()=> console.log('PLAYER HIT by projectile', p.type || '', 'hp=', player.health), 250);
                    // apply projectile->player knockback
                    const pm = p.mass || 0.6;
                    const nx = (player.x - p.x) / Math.max(0.0001, d);
                    const ny = (player.y - p.y) / Math.max(0.0001, d);
                    player.vx = (player.vx || 0) + nx * (pm / player.mass) * 8;
                    player.vy = (player.vy || 0) + ny * (pm / player.mass) * 8;
                    mob.projectiles.splice(pi, 1);
                }
            }
        }

        /* --- Mob death --- */
        if(mob.health <= 0){
            if(window.COLLISION_LOGS) throttleLog('mob-died-'+(mob.name||mob.type), ()=> console.log('MOB DIED', mob.name || mob.type), 500);
            spawnMobDrops(mob);
            mobs.splice(mi, 1);
        }
    }

    /* --- Player projectiles ↔ Mobs (single-hit safe) --- */
    for(let pi = projectiles.length - 1; pi >= 0; pi--){
        const proj = projectiles[pi];
        let hit = false;

        for(let mi = mobs.length - 1; mi >= 0; mi--){
            const mob = mobs[mi];
            const d = Math.hypot(mob.x - proj.x, mob.y - proj.y);

            if(d < mob.radius + (proj.radius || 4)){
                mob.health -= (proj.damage || 1);
                hit = true;

                    // apply projectile momentum to mob (knockback proportional to proj.mass)
                    const pm = proj.mass || 0.5;
                    const mm = mob.mass || 1;
                    const nx = (mob.x - proj.x) / Math.max(0.0001, d);
                    const ny = (mob.y - proj.y) / Math.max(0.0001, d);
                    mob.vx = (mob.vx || 0) + nx * (pm / mm) * 6;
                    mob.vy = (mob.vy || 0) + ny * (pm / mm) * 6;

                if(mob.health <= 0){
                    spawnMobDrops(mob);
                    mobs.splice(mi, 1);
                }
                break;
            }
        }

        if(hit) projectiles.splice(pi, 1);
    }

    /* --- Drop pickup (true circular collision) --- */
    drops = drops.filter(drop => {
        const d = Math.hypot(player.x - drop.x, player.y - drop.y);
        if(d < player.radius + drop.radius){
            // when picking up a drop, add it to inventory and persist state
            addToInventory(drop.type, drop.rarity || 'Common', drop.stack || 1);
            try{ savePlayerState(); }catch(e){}
            return false;
        }
        return true;
    });

    /* --- Death check --- */
    if(player.health <= 0 && !isDead){
        isDead = true;
        onDeath();
    }

    if(!isDead && mobs.length === 0){
        spawnWave(currentWave++);
    }
}

// --- ITEM USAGE ---
document.addEventListener('keydown', e=>{
    if(e.key.toLowerCase()==='e'){
        if(isDead) return;
        // cycle through equipped slots so each press uses the next slot (rotation-friendly)
        const startIndex = nextEquipIndex % player.equipped.length;
        for(let offset=0; offset<player.equipped.length; offset++){
            const i = (startIndex + offset) % player.equipped.length;
            const slot = player.equipped[i];
            if(!slot) continue;
            // allow default behavior for unknown types
            const base = ITEM_TYPES[slot.type] || null;
            const now = Date.now();
            const cooldown = base ? base.cooldown : 900;
            if(!player.cooldowns[slot.type] || now - player.cooldowns[slot.type] >= cooldown){
                // compute firing position using petals angles - map equip index to a petal index
                const petalIndex = i % petals.length;
                let sx = player.x, sy = player.y;
                if(petals[petalIndex]){
                    sx = player.x + Math.cos(petals[petalIndex].angle) * player.petalsDistance;
                    sy = player.y + Math.sin(petals[petalIndex].angle) * player.petalsDistance;
                }
                if(slot.type === 'Rose' && base){
                    player.health = Math.min(player.maxHealth, player.health + base.heal);
                } else {
                    const angle = Math.atan2(0,1); // shoot to the right by default
                    const damage = base ? base.damage : (slot.rarity==='Rare'?4:(slot.rarity==='Epic'?8:(slot.rarity==='Legendary'?16:2)));
                    projectiles.push({x: sx, y: sy, dx: Math.cos(angle)*6, dy: Math.sin(angle)*6, radius:6, type: slot.type, damage: damage});
                }
                // consume one
                slot.stack = (slot.stack || 1) - 1;
                player.cooldowns[slot.type] = now;
                if(slot.stack <= 0){ slot.stack = 0; slot.empty = true; slot.type = null; }
                try{ savePlayerState(); }catch(e){}
                nextEquipIndex = i + 1;
                break;
            }
        }
    }
});

// Rendering helpers for UI modals
function renderInventory(){
    const grid = document.getElementById('invGrid');
    let slots = document.getElementById('equipSlots');
    if(!grid) return;
    // create equipSlots area if it doesn't exist (inventory layout changed)
    if(!slots){
        slots = document.createElement('div');
        slots.id = 'equipSlots';
        slots.style.display = 'flex';
        slots.style.flexWrap = 'wrap';
        slots.style.gap = '6px';
        slots.style.padding = '8px';
        slots.style.background = 'rgba(255,255,255,0.06)';
        slots.style.borderRadius = '6px';
        const invModal = document.getElementById('inventoryModal');
        if(invModal) invModal.appendChild(slots);
    }
    const query = (document.getElementById('invSearch')||{}).value || '';
    const sort = (document.getElementById('invSort')||{}).value || 'type';
    // simple copy of inventory sorted/filtered
    let items = player.inventory.slice();
    if(query) items = items.filter(it=>it.type.toLowerCase().includes(query.toLowerCase()));
    if(sort==='rarity') items.sort((a,b)=> (a.rarity||'')>=(b.rarity||'')?1:-1); else items.sort((a,b)=> a.type.localeCompare(b.type));

    grid.innerHTML='';
    if(items.length===0) grid.innerHTML='<div style="opacity:0.6">No items</div>';
    items.forEach((it,idx)=>{
        const d = document.createElement('div');
        d.style.display='inline-block'; d.style.width='56px'; d.style.height='56px'; d.style.margin='6px'; d.style.background='#fff'; d.style.border='2px solid #ccc'; d.style.borderRadius='6px'; d.style.position='relative'; d.style.cursor='pointer';
        d.dataset.idx = idx;
        // apply rarity color
        const rarity = (it.rarity||'Common');
        const rarityColors = { Common:'#d8f4d8', Unusual:'#fff7c2', Rare:'#2b4b9a', Epic:'#cdb3ff', Legendary:'#ffb3b3' };
        const rc = rarityColors[rarity] || '#fff';
        d.style.borderColor = rc;
        const def = (window.PETAL_DEFS && (window.PETAL_DEFS[it.type] || window.PETAL_DEFS[(it.type||'').toLowerCase()])) || null;
        const label = def && (def.name || def.id) ? (def.name || def.id) : it.type;
        const iconURL = getPetalIconURL(it.type, it.rarity||'Common', 36);
        d.innerHTML = `<img src="${iconURL}" style="width:34px;height:34px;display:block;margin:4px auto 0;border-radius:8px"/><div style=\"font-size:11px;text-align:center;margin-top:2px\">${label}</div><div style=\"position:absolute;right:4px;bottom:4px;font-weight:700;background:rgba(0,0,0,0.6);color:#fff;padding:2px 6px;border-radius:10px;\">${it.stack}x</div>`;
        d.draggable = true;
        d.title = (def && def.description) ? `${label} - ${def.description} (${it.rarity||'Common'}) x${it.stack}` : `${it.type} (${it.rarity||'Common'}) x${it.stack}`;
        d.dataset.type = it.type; d.dataset.rarity = it.rarity || 'Common';
        // color the icon background by rarity for better visual cue
        try{ const bg = RARITY_COLOR[it.rarity || 'Common'] || '#ddd'; const img = d.querySelector('img'); if(img) img.style.background = bg; }catch(e){}
        d.addEventListener('dragstart', (ev)=>{
            try{ ev.dataTransfer.setData('text/plain', JSON.stringify({type:it.type,rarity:it.rarity||'Common'})); }catch(e){}
        });
        d.addEventListener('click', (ev)=>{
            // equip item: remove one from inventory and put into first empty equip slot
            const globalIdx = player.inventory.indexOf(it);
            if(globalIdx===-1) return;
            // auto-place: prefer main row, if full put into swap row; if both full do nothing
            const emptyMain = player.equipped.findIndex(s=>!s);
            if(emptyMain !== -1){
                player.equipped[emptyMain] = {type:it.type,rarity:it.rarity,stack:1, empty:false};
                try{ applyOnEquip(emptyMain, false); }catch(e){}
            } else {
                const emptySwap = player.swap.findIndex(s=>!s);
                if(emptySwap !== -1){
                    player.swap[emptySwap] = {type:it.type,rarity:it.rarity,stack:1, empty:false};
                    try{ applyOnEquip(emptySwap, true); }catch(e){}
                } else {
                    // both rows full -> do nothing (no popup)
                    return;
                }
            }
            try{ savePlayerState(); }catch(e){}
            it.stack--; if(it.stack<=0) player.inventory.splice(globalIdx,1);
            refreshPetals();
            renderInventory();
            // reflect immediately in hotbar UI
            try{ updateHotbarUI(); }catch(e){}
            try{ if(typeof runEquipHooks === 'function') runEquipHooks(); }catch(e){}
        });
        grid.appendChild(d);
    });

    // render equipped slots (10 slots)
    slots.innerHTML = '';
    for(let si=0; si<10; si++){
        const s = player.equipped[si] || null;
        const sd = document.createElement('div'); sd.style.width='48px'; sd.style.height='48px'; sd.style.border='2px solid rgba(0,0,0,0.12)'; sd.style.display='flex'; sd.style.alignItems='center'; sd.style.justifyContent='center'; sd.style.background='rgba(255,255,255,0.06)'; sd.style.borderRadius='8px'; sd.style.cursor='pointer'; sd.style.margin='4px';
        if(s){
            const def = (window.PETAL_DEFS && (window.PETAL_DEFS[s.type] || window.PETAL_DEFS[(s.type||'').toLowerCase()])) || null;
            const label = def && (def.name||def.id) ? (def.name||def.id) : s.type;
            const icon = document.createElement('img'); icon.src = getPetalIconURL(s.type, s.rarity||'Common', 28); icon.style.width='28px'; icon.style.height='28px'; icon.style.display='block'; icon.style.margin='2px auto 0'; icon.style.borderRadius='6px';
            try{ icon.style.background = RARITY_COLOR[s.rarity||'Common'] || '#ddd'; }catch(e){}
            sd.appendChild(icon);
            const lbl = document.createElement('div'); lbl.style.fontSize='11px'; lbl.style.textAlign='center'; lbl.textContent = label; sd.appendChild(lbl);
            sd.title = (def && def.description) ? `${label} - ${def.description} (${s.rarity||'Common'}) x${s.stack||1}` : ((s.rarity||'Common') + ' x' + (s.stack||1));
            try{ sd.dataset.type = def && (def.id||def.name) ? (def.id||def.name) : s.type; sd.dataset.rarity = s.rarity || 'Common'; }catch(e){}
            sd.addEventListener('click', ()=>{ try{ applyOnUnequip(si, false); }catch(e){} addToInventory(s.type,s.rarity, (s.stack||1)); player.equipped[si] = null; try{ savePlayerState(); }catch(e){} refreshPetals(); renderInventory(); updateHotbarUI(); try{ if(typeof runEquipHooks === 'function') runEquipHooks(); }catch(e){} });
        } else { sd.textContent = ''; }
        slots.appendChild(sd);
    }
    // also render main equip area in the center of the start screen if present
    const main = document.getElementById('mainEquip');
    if(main){
        main.innerHTML = '';
        for(let si=0; si<10; si++){
            const s = player.equipped[si] || null;
            const md = document.createElement('div'); md.className='slot'; md.style.opacity = s? (s.empty? '0.35' : '1') : '0.35';
            md.style.width='52px'; md.style.height='52px'; md.dataset.slot = si;
            if(s){
                    const def = (window.PETAL_DEFS && (window.PETAL_DEFS[s.type] || window.PETAL_DEFS[(s.type||'').toLowerCase()])) || null;
                    const label = def && (def.name||def.id) ? (def.name||def.id) : s.type;
                    const icon = document.createElement('img'); icon.src = getPetalIconURL(s.type, s.rarity||'Common', 36); icon.style.width='34px'; icon.style.height='34px'; icon.style.display='block'; icon.style.margin='2px auto 0'; icon.style.borderRadius='6px';
                    try{ icon.style.background = RARITY_COLOR[s.rarity||'Common'] || '#ddd'; }catch(e){}
                    md.appendChild(icon);
                    const lbl = document.createElement('div'); lbl.style.fontSize='12px'; lbl.style.textAlign='center'; lbl.textContent = label; md.appendChild(lbl);
                    md.title = (def && def.description) ? `${label} - ${def.description} (${s.rarity||'Common'}) x${s.stack||1}` : ((s.rarity||'Common') + ' x' + (s.stack||1));
                    try{ md.dataset.type = def && (def.id||def.name) ? (def.id||def.name) : s.type; md.dataset.rarity = s.rarity || 'Common'; }catch(e){}
                    md.addEventListener('click', ()=>{ try{ applyOnUnequip(si, false); }catch(e){} addToInventory(s.type,s.rarity, (s.stack||1)); player.equipped[si] = null; try{ savePlayerState(); }catch(e){} refreshPetals(); renderInventory(); updateHotbarUI(); try{ if(typeof runEquipHooks === 'function') runEquipHooks(); }catch(e){} });
            } else { md.textContent = ''; }
            main.appendChild(md);
        }
    }
}

// Update the viewport hotbar DOM to reflect `player.equipped` and `player.swap`.
function updateHotbarUI(){
    const root = document.getElementById('HOTBAR_ROOT');
    if(!root) return;
    const main = root.querySelector('#hotbarMain');
    const swap = root.querySelector('#hotbarSwap');
    if(main){
        for(let i=0;i<10;i++){
            const el = main.children[i];
            const s = player.equipped[i];
            if(!el) continue;
            el.innerHTML = '';
            if(s && s.type && !s.empty){
                const def = (window.PETAL_DEFS && (window.PETAL_DEFS[s.type] || window.PETAL_DEFS[(s.type||'').toLowerCase()])) || null;
                const label = def && (def.name||def.id) ? (def.name||def.id) : s.type;
                    const icon = document.createElement('img'); icon.src = getPetalIconURL(s.type, s.rarity||'Common', 28); icon.style.width='28px'; icon.style.height='28px'; icon.style.display='block'; icon.style.margin='2px auto 0'; icon.style.borderRadius='6px';
                    try{ icon.style.background = RARITY_COLOR[s.rarity||'Common'] || '#ddd'; }catch(e){}
                    el.appendChild(icon);
                    const lbl = document.createElement('div'); lbl.style.fontSize='11px'; lbl.style.textAlign='center'; lbl.textContent = label; el.appendChild(lbl);
                    el.title = def && def.description ? `${label} - ${def.description}` : `${s.type} (${s.rarity||'Common'})`;
                    // expose data attributes for tooltip delegation
                    try{ if(def && (def.id || def.name)) el.dataset.type = def.id || def.name; else el.dataset.type = s.type; el.dataset.rarity = s.rarity || 'Common'; }catch(e){}
                // color by rarity when available
                try{ const rarityColors = { Common:'#d8f4d8', Unusual:'#fff7c2', Rare:'#2b4b9a', Epic:'#cdb3ff', Legendary:'#ffb3b3' }; el.style.borderColor = rarityColors[s.rarity||'Common'] || ''; }catch(e){}
            }
        }
    }
    if(swap){
        for(let i=0;i<10;i++){
            const el = swap.children[i];
            const s = player.swap[i];
            if(!el) continue;
            el.innerHTML = '';
            if(s && s.type && !s.empty){
                const def = (window.PETAL_DEFS && (window.PETAL_DEFS[s.type] || window.PETAL_DEFS[(s.type||'').toLowerCase()])) || null;
                const label = def && (def.name||def.id) ? (def.name||def.id) : s.type;
                const icon = document.createElement('img'); icon.src = getPetalIconURL(s.type, s.rarity||'Common', 24); icon.style.width='24px'; icon.style.height='24px'; icon.style.display='block'; icon.style.margin='2px auto 0'; icon.style.borderRadius='6px';
                try{ icon.style.background = RARITY_COLOR[s.rarity||'Common'] || '#ddd'; }catch(e){}
                el.appendChild(icon);
                const lbl = document.createElement('div'); lbl.style.fontSize='10px'; lbl.style.textAlign='center'; lbl.textContent = label; el.appendChild(lbl);
                el.title = def && def.description ? `${label} - ${def.description}` : `${s.type} (${s.rarity||'Common'})`;
                try{ if(def && (def.id || def.name)) el.dataset.type = def.id || def.name; else el.dataset.type = s.type; el.dataset.rarity = s.rarity || 'Common'; }catch(e){}
                try{ const rarityColors = { Common:'#d8f4d8', Unusual:'#fff7c2', Rare:'#2b4b9a', Epic:'#cdb3ff', Legendary:'#ffb3b3' }; el.style.borderColor = rarityColors[s.rarity||'Common'] || ''; }catch(e){}
            }
        }
    }
}

// Keybinds: pressing 1-9 or 0 will swap the main <-> swap slot at that index
document.addEventListener('keydown', function(ev){
    const active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) return;
    const key = ev.key;
    if(!key) return;
    let idx = null;
    if(key === '0') idx = 10; else if(/^[1-9]$/.test(key)) idx = parseInt(key,10);
    if(!idx) return;
    // 1-based to 0-based index
    const i = idx - 1;
    // swap main <-> swap
    const a = player.equipped[i];
    const b = player.swap[i];
    player.equipped[i] = b;
    player.swap[i] = a;
    try{ savePlayerState(); }catch(e){}
    refreshPetals(); updateHotbarUI(); if(window.renderInventory) window.renderInventory();
    try{ if(typeof runEquipHooks === 'function') runEquipHooks(); }catch(e){}
});

// Attach drag/drop & click handlers to the hotbar when it appears in the DOM.
function attachHotbarListeners(){
    const root = document.getElementById('HOTBAR_ROOT');
    if(!root) return;
    // ensure we only attach once
    if(root._listenersAttached) return; root._listenersAttached = true;

    root.addEventListener('dragover', function(ev){ ev.preventDefault(); });
    root.addEventListener('drop', function(ev){
        ev.preventDefault();
        try{
            const txt = ev.dataTransfer.getData('text/plain');
            if(!txt) return;
            const payload = JSON.parse(txt);
            const slot = ev.target.closest('.hotbar-slot');
            if(!slot) return;
            const isSwap = slot.hasAttribute('data-hot-swap');
            const idx = parseInt(isSwap ? slot.getAttribute('data-hot-swap') : slot.getAttribute('data-hot'), 10) - 1;
            if(Number.isNaN(idx) || idx < 0) return;

            // If dragging from another hotbar slot -> swap/move between slots
            if(payload && payload.fromHot){
                const srcIndex = payload.index;
                const srcIsSwap = !!payload.isSwap;
                if(typeof srcIndex !== 'number') return;
                // get references
                const srcArr = srcIsSwap ? player.swap : player.equipped;
                const dstArr = isSwap ? player.swap : player.equipped;
                // perform swap
                const tmp = dstArr[idx];
                dstArr[idx] = srcArr[srcIndex];
                srcArr[srcIndex] = tmp;
                try{ savePlayerState(); }catch(e){}
                refreshPetals(); updateHotbarUI(); if(window.renderInventory) window.renderInventory();
                try{ if(typeof runEquipHooks === 'function') runEquipHooks(); }catch(e){}
                return;
            }

            // Otherwise, payload is an inventory item -> equip into target
            const invIdx = player.inventory.findIndex(it=> it.type === payload.type && (it.rarity||'Common') === (payload.rarity||'Common'));
            if(invIdx === -1) return;
            if(isSwap){ player.swap[idx] = { type: payload.type, rarity: payload.rarity||'Common', stack: 1, empty:false }; }
            else { player.equipped[idx] = { type: payload.type, rarity: payload.rarity||'Common', stack: 1, empty:false }; }
            player.inventory[invIdx].stack--; if(player.inventory[invIdx].stack <= 0) player.inventory.splice(invIdx,1);
            try{ savePlayerState(); }catch(e){}
            try{ applyOnEquip(idx, isSwap); }catch(e){}
            refreshPetals(); updateHotbarUI(); if(window.renderInventory) window.renderInventory();
            try{ if(typeof runEquipHooks === 'function') runEquipHooks(); }catch(e){}
        }catch(e){}
    });

    // ensure each hotbar-slot is draggable and sends a source payload when dragged
    const slotEls = Array.from(root.querySelectorAll('.hotbar-slot'));
    slotEls.forEach(slot => {
        try{ slot.draggable = true; }catch(e){}
        slot.addEventListener('dragstart', function(ev){
            const isSwap = slot.hasAttribute('data-hot-swap');
            const idx = parseInt(isSwap ? slot.getAttribute('data-hot-swap') : slot.getAttribute('data-hot'), 10) - 1;
            if(Number.isNaN(idx) || idx < 0) return;
            const payload = { fromHot: true, index: idx, isSwap: !!isSwap };
            try{ ev.dataTransfer.setData('text/plain', JSON.stringify(payload)); }catch(e){}
        });
    });

    // click handler on hotbar slots: swap the clicked slot with its paired slot (main <-> swap)
    root.addEventListener('click', function(ev){
        const slot = ev.target.closest('.hotbar-slot');
        if(!slot) return;
        const isSwap = slot.hasAttribute('data-hot-swap');
        const idx = parseInt(isSwap ? slot.getAttribute('data-hot-swap') : slot.getAttribute('data-hot'), 10) - 1;
        if(Number.isNaN(idx) || idx < 0) return;

        // determine source and destination arrays
        const srcArr = isSwap ? player.swap : player.equipped;
        const dstArr = isSwap ? player.equipped : player.swap; // paired slot

        // perform swap/move: always swap values (can be null)
        const tmp = dstArr[idx];
        dstArr[idx] = srcArr[idx];
        srcArr[idx] = tmp;

        try{ savePlayerState(); }catch(e){}
        refreshPetals(); updateHotbarUI(); if(window.renderInventory) window.renderInventory();
        try{ if(typeof runEquipHooks === 'function') runEquipHooks(); }catch(e){}
    });
}

// poll for hotbar root and attach listeners (runs until attached)
const _hotbarPoll = setInterval(()=>{ try{ attachHotbarListeners(); updateHotbarUI(); if(document.getElementById('HOTBAR_ROOT') && document.getElementById('HOTBAR_ROOT')._listenersAttached){ clearInterval(_hotbarPoll); } }catch(e){} }, 200);

// craft UI removed: replaced by simple `#craftPanel` in index.html

// doCraftAction removed

// Update preview, chance display, and craft button enabled state
// updateCraftUI removed

// small transient toast inside craft modal
// showCraftToast removed

function renderSeen(){
    const out = document.getElementById('seenContent'); if(!out) return; out.innerHTML='';
    const keys = Object.keys(player.seenMobs||{});
    if(keys.length===0) out.innerHTML = '<div style="opacity:0.6">No mobs yet</div>';
    keys.forEach(k=>{
        const m = player.seenMobs[k];
        const el = document.createElement('div'); el.style.border='1px solid #ddd'; el.style.padding='6px'; el.style.borderRadius='6px'; el.style.background='#fff';
        el.innerHTML = `<div style="font-weight:700">${m.name}</div><div style="font-size:12px">Killed: ${m.count}</div>`;
        out.appendChild(el);
    });
}

// Inventory helpers used by crafting
function getInventoryCount(type, rarity){ rarity = rarity || 'Common'; let c = 0; player.inventory.forEach(it=>{ if(it.type===type && (it.rarity||'Common')===rarity) c += (it.stack||1); }); return c; }
function removeFromInventory(type, rarity, amount){ rarity = rarity || 'Common'; let toRemove = amount; for(let i=player.inventory.length-1;i>=0 && toRemove>0;i--){ const it = player.inventory[i]; if(it.type===type && (it.rarity||'Common')===rarity){ const take = Math.min(it.stack||1, toRemove); it.stack = (it.stack||1) - take; toRemove -= take; if(it.stack <= 0) player.inventory.splice(i,1); } } return amount - toRemove; }
function removeFromInventory(type, rarity, amount){ rarity = rarity || 'Common'; let toRemove = amount; for(let i=player.inventory.length-1;i>=0 && toRemove>0;i--){ const it = player.inventory[i]; if(it.type===type && (it.rarity||'Common')===rarity){ const take = Math.min(it.stack||1, toRemove); it.stack = (it.stack||1) - take; toRemove -= take; if(it.stack <= 0) player.inventory.splice(i,1); } } try{ savePlayerState(); }catch(e){} return amount - toRemove; }
function nextRarity(r){ const idx = RARITY_NAMES.indexOf(r||'Common'); if(idx<0) return null; return RARITY_NAMES[Math.min(RARITY_NAMES.length-1, idx+1)]; }

// expose inventory/seen renderers
window.renderInventory = renderInventory;
window.renderSeen = renderSeen;
// Toggle the simple craft panel (replaces previous craft modal)
window.toggleCraft = function(){ const el = document.getElementById('craftPanel'); if(!el) return; el.hidden = !el.hidden; };

function onDeath(){
    // show main screen so player can equip/unequip before restarting
    const ss = document.getElementById('startScreen'); if(ss) ss.style.display='flex';
    // hide canvas to show main menu clearly
    if(canvas) canvas.style.display = 'none';
    // allow opening inventory/craft/seen while dead (toggles already available)
    if(window.renderInventory) window.renderInventory();
    // show HUD when back on main/start screen
    try{ setHUDVisible(true); }catch(e){}
}

// spacebar / mouse hold to expand petals
document.addEventListener('keydown', e=>{ if(e.code === 'Space') spaceHeld = true; });
document.addEventListener('keyup', e=>{ if(e.code === 'Space') spaceHeld = false; });
document.addEventListener('mousedown', e=>{ if(e.button === 0) mouseHeld = true; });
document.addEventListener('mouseup', e=>{ if(e.button === 0) mouseHeld = false; });

// wire modal toggles to render
window.toggleInventory = function(){ const el=document.getElementById('inventoryModal'); if(!el) return; const vis = (el.style.display==='block'); if(!vis) renderInventory(); el.style.display = vis?'none':'block'; };
window.toggleCraft = function(){ const el=document.getElementById('craftModal'); if(!el) return; const vis = (el.style.display==='block'); if(!vis) renderCraft(); el.style.display = vis?'none':'block'; };
window.toggleSeen = function(){ const el=document.getElementById('seenModal'); if(!el) return; const vis = (el.style.display==='block'); if(!vis) renderSeen(); el.style.display = vis?'none':'block'; };

// Show/hide HUD (settings and quick buttons) when entering/exiting gameplay
function setHUDVisible(visible){
    const selectors = [
        '#settingsBtn','#settingsButton','#topSettingsBtn','.settings','.settings-btn','.gear-button',
        '#cornerButtons','#quickButtons','.quick-buttons','.quick-button','.quickBtn',
        '#inventoryButton','#craftButton','#seenButton','#btnX','#btnC','#btnV'
    ];
    const list = document.querySelectorAll(selectors.join(','));
    list.forEach(el=>{ try{ el.style.display = visible ? '' : 'none'; }catch(e){} });
}


// --- RESPAWN ---
document.addEventListener("keydown", e=>{
    if(isDead && e.key==="Enter"){
        isDead=false;
        player.health=player.maxHealth;
        player.x=CENTER_X;
        player.y=CENTER_Y;
        mobs=[];
        drops=[];
        projectiles=[];
        spawnWave(currentWave);
    }
});

// --- DRAW FUNCTIONS ---
function drawPlayer(){
    ctx.fillStyle = 'pink';
    ctx.beginPath(); ctx.arc(player.x, player.y, player.radius, 0, Math.PI*2); ctx.fill();
    if(showHitboxes){ ctx.strokeStyle='red'; ctx.lineWidth=2; ctx.beginPath(); ctx.arc(player.x,player.y,player.radius,0,Math.PI*2); ctx.stroke(); }
}
// draw player hit flash
const PLAYER_HIT_FLASH_MS = 300;
function drawPlayerHit(){
    if(player._hitFlash && Date.now() - player._hitFlash < PLAYER_HIT_FLASH_MS){
        ctx.strokeStyle = 'red'; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(player.x,player.y,player.radius+4,0,Math.PI*2); ctx.stroke();
    }
}
function drawPetals(){
    // draw passive petals around the player (visual only, no DOM dependency)
    for(let i=0;i<petals.length;i++){
        const p = petals[i];
        const px = player.x + Math.cos(p.angle) * player.petalsDistance;
        const py = player.y + Math.sin(p.angle) * player.petalsDistance;
        ctx.save();
        ctx.beginPath(); ctx.fillStyle = '#fff'; ctx.globalAlpha = 0.95; ctx.arc(px, py, p.radius || 6, 0, Math.PI*2); ctx.fill();
        ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(0,0,0,0.15)'; ctx.stroke();
        ctx.restore();
    }
}
function drawMobs(){
    mobs.forEach(mob=>{
        // body
        ctx.fillStyle = (mob.type==="Bee")?"#f7d86b":(mob.type==="Hornet")?"#ffb86b":"#ff6b6b";
        ctx.beginPath(); ctx.arc(mob.x,mob.y,mob.radius,0,Math.PI*2); ctx.fill();

        // health bar under mob with name left and rarity right
        const rarity = mob.rarityName || mob.rarity || 'Common';
        let rcolor = RARITY_COLOR[rarity] || '#000';
        const isRainbow = (rarity === 'Impracticality');
        if(isRainbow){ const hue = Math.floor((Date.now()/40) % 360); rcolor = `hsl(${hue},100%,60%)`; }

        const hpRatio = Math.max(0, Math.min(1, (mob.health || 0) / (mob.maxHealth || 1)));
        const barWidth = Math.max(44, Math.round(mob.radius * 2.6));
        const barHeight = 8;
        const bx = Math.round(mob.x - barWidth/2);
        const by = Math.round(mob.y + mob.radius + 6);

        // rounded background
        ctx.beginPath(); const r = 4; roundRectPath(ctx, bx-1, by-1, barWidth+2, barHeight+2, r); ctx.fillStyle = '#222'; ctx.fill(); ctx.strokeStyle='black'; ctx.lineWidth=1; ctx.stroke();
        // fill (green)
        ctx.beginPath(); roundRectPath(ctx, bx, by, Math.max(2, Math.round(barWidth * hpRatio)), barHeight, r); ctx.fillStyle = '#3fc34f'; ctx.fill();

        // name on the left of the bar
        ctx.font = '12px Arial'; ctx.textBaseline = 'middle';
        const nameX = bx - 8; const nameY = by + Math.round(barHeight/2);
        const nameStroke = isRainbow ? '#000' : contrastColor(RARITY_COLOR[rarity] || '#000');
        ctx.textAlign = 'right'; ctx.lineWidth = 3; ctx.strokeStyle = nameStroke; ctx.strokeText(mob.name || '', nameX, nameY);
        ctx.fillStyle = rcolor; ctx.fillText(mob.name || '', nameX, nameY);

        // rarity text on right of bar (colored by rarity)
        const rarityX = bx + barWidth + 8; const rarityY = nameY;
        const rarityStroke = isRainbow ? '#000' : contrastColor(RARITY_COLOR[rarity] || '#000');
        ctx.textAlign = 'left'; ctx.lineWidth = 3; ctx.strokeStyle = rarityStroke; ctx.strokeText(rarity, rarityX, rarityY);
        ctx.fillStyle = rcolor; ctx.fillText(rarity, rarityX, rarityY);

        // draw projectiles
        mob.projectiles.forEach(p=>{
            ctx.fillStyle=(p.type==="Missile")?"grey":"#f7d86b";
            ctx.beginPath(); ctx.arc(p.x,p.y,p.radius,0,Math.PI*2); ctx.fill();
            if(showHitboxes){ ctx.strokeStyle='red'; ctx.lineWidth=1; ctx.beginPath(); ctx.arc(p.x,p.y,p.radius,0,Math.PI*2); ctx.stroke(); }
        });
        // hit flash outline when recently damaged
        if(mob._hitFlash && Date.now() - mob._hitFlash < 300){ ctx.strokeStyle='red'; ctx.lineWidth=3; ctx.beginPath(); ctx.arc(mob.x,mob.y,mob.radius+3,0,Math.PI*2); ctx.stroke(); }
        // collision debug highlight
        if(mob._debug){ ctx.strokeStyle='magenta'; ctx.lineWidth=3; ctx.beginPath(); ctx.arc(mob.x,mob.y,mob.radius+6,0,Math.PI*2); ctx.stroke(); ctx.fillStyle='magenta'; ctx.font='12px monospace'; ctx.fillText('COLLIDE', mob.x, mob.y - mob.radius - 10); }
    });
}
function drawDrops(){ drops.forEach(drop=>{ ctx.fillStyle="green"; ctx.fillRect(drop.x-8,drop.y-8,16,16); ctx.strokeStyle="black"; ctx.strokeRect(drop.x-8,drop.y-8,16,16); if(showHitboxes){ ctx.strokeStyle='red'; ctx.lineWidth=1; ctx.strokeRect(drop.x-8,drop.y-8,16,16); } ctx.fillStyle="black"; ctx.fillText(drop.type,drop.x-8,drop.y-12); }); }
function drawUI(){ ctx.fillStyle="black"; ctx.fillText("HP: "+Math.floor(player.health),10,20); ctx.fillText("Wave: "+currentWave,viewWidth-100,20); }

// Debug overlay: shows counts, coordinates, and a crosshair for the player
function drawDebugOverlay(){
    if(typeof DEBUG_SHOW === 'undefined') DEBUG_SHOW = true;
    if(!DEBUG_SHOW) return;
    const pad = 8;
    const w = 260, h = 88;
    ctx.save();
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.beginPath(); roundRectPath(ctx, pad-4, 30-12, w, h, 6);
    ctx.fill();
    ctx.fillStyle = 'white';
    ctx.font = '12px monospace';
    ctx.textAlign = 'left';
    ctx.fillText('player: ' + player.x.toFixed(1) + ', ' + player.y.toFixed(1), pad, 40);
    ctx.fillText('view: ' + viewWidth.toFixed(0) + ' x ' + viewHeight.toFixed(0), pad, 58);
    ctx.fillText('mobs: ' + mobs.length + ' proj: ' + projectiles.length + ' drops: ' + drops.length, pad, 76);
    ctx.fillText('wave: ' + currentWave + (isDead? ' (DEAD)':'') , pad, 94);

    // draw crosshair at player position
    ctx.lineWidth = 2; ctx.strokeStyle = 'red'; ctx.beginPath();
    ctx.moveTo(player.x - 14, player.y - 14); ctx.lineTo(player.x + 14, player.y + 14);
    ctx.moveTo(player.x + 14, player.y - 14); ctx.lineTo(player.x - 14, player.y + 14);
    ctx.stroke();
    ctx.beginPath(); ctx.arc(player.x, player.y, player.radius + 6, 0, Math.PI*2); ctx.stroke();
    ctx.restore();
    // DOM overlay removed; keep diagnostics visible via console logs when needed
}

// Huge flashing center marker to guarantee the player is visible during debugging
function drawHugeCenterMarker(){
    if(typeof DEBUG_FORCE_CENTER === 'undefined' || !DEBUG_FORCE_CENTER) return;
    const t = Date.now();
    const on = Math.floor(t/300) % 2 === 0;
    ctx.save();
    ctx.globalAlpha = on ? 0.95 : 0.45;
    ctx.fillStyle = 'rgba(255,255,0,0.9)';
    ctx.beginPath(); ctx.arc(CENTER_X, CENTER_Y, Math.max(32, Math.min(viewWidth, viewHeight) * 0.08), 0, Math.PI*2); ctx.fill();
    ctx.lineWidth = 4; ctx.strokeStyle = 'black'; ctx.beginPath(); ctx.arc(CENTER_X, CENTER_Y, Math.max(36, Math.min(viewWidth, viewHeight) * 0.08 + 4), 0, Math.PI*2); ctx.stroke();
    ctx.fillStyle = 'black'; ctx.font = '18px Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('PLAYER', CENTER_X, CENTER_Y);
    ctx.restore();
}

// --- DEATH OVERLAY ---
function drawDeathOverlay(){
    ctx.fillStyle="rgba(100,100,100,0.6)";
    ctx.fillRect(0,0,viewWidth,viewHeight);
    // Player dead face
    ctx.fillStyle="pink";
    ctx.beginPath(); ctx.arc(CENTER_X,CENTER_Y,player.radius,0,Math.PI*2); ctx.fill();
    ctx.fillStyle="black";
    ctx.font="20px Arial";
    ctx.fillText("x_x",CENTER_X-15,CENTER_Y-5);
    ctx.fillText("☹",CENTER_X-10,CENTER_Y+15);
    ctx.font="16px Arial";
    ctx.fillText("Press Enter to respawn",CENTER_X-80,CENTER_Y+50);
}

// --- GAME LOOP ---
function gameLoop(){
    ctx.fillStyle="#3CB043"; // green background
    ctx.fillRect(0,0,viewWidth,viewHeight);

    movePlayer(); moveMobs(); updatePetals(); updatePetalDistance(); updateProjectiles(); checkCollisions();
    applyPassiveEffects();
    drawPlayer(); drawPlayerHit(); drawPetals(); drawMobs(); drawDrops(); drawProjectiles(); drawUI();
    // debug overlay to help locate player and coordinate issues (non-intrusive)
    if(typeof DEBUG_SHOW !== 'undefined' && DEBUG_SHOW) drawDebugOverlay();

    if(isDead) drawDeathOverlay();

    if(!isDead){
        animationId = requestAnimationFrame(gameLoop);
    } else {
        animationId = null;
    }
}

// (toggle functions defined earlier wire rendering when opening)

// Start the game loop and spawn the first wave. Called from the start screen Play button.
window.startGame = function(){
    console.log('DEBUG startGame: begin');
    // hide start screen if present
    try{
        const ss = document.getElementById('startScreen'); if(ss){ ss.style.display='none'; console.log('DEBUG startGame: hid start screen'); }
    }catch(e){ console.warn('startGame: could not hide start screen', e); }

    // show canvas (index.html will do this too, but double-safe)
    try{ canvas.style.display = 'block'; console.log('DEBUG startGame: canvas shown'); }catch(e){ console.warn('startGame: canvas show failed', e); }

    // attempt to lock page scroll and make canvas fill viewport, but don't fail initialization on error
    try{
        document.documentElement.style.overflow = 'hidden';
        document.body.style.overflow = 'hidden';
        document.body.style.margin = '0';
        canvas.style.position = 'fixed'; canvas.style.left = '0'; canvas.style.top = '0';
        canvas.style.width = '100vw'; canvas.style.height = '100vh';
        console.log('DEBUG startGame: applied fullscreen CSS');
    }catch(e){ console.warn('startGame: fullscreen CSS failed', e); }

    // recalc canvas backing store to match new CSS size; fallback to window sizes if needed
    try{
        resizeCanvas();
        if(!viewWidth || !viewHeight){
            viewWidth = window.innerWidth || 800;
            viewHeight = window.innerHeight || 600;
            CENTER_X = Math.round(viewWidth/2); CENTER_Y = Math.round(viewHeight/2);
            console.warn('startGame: resizeCanvas produced zero view; using window.inner sizes', viewWidth, viewHeight);
        }
        console.log('DEBUG startGame: resizeCanvas ok view=', viewWidth, viewHeight, 'CENTER=', CENTER_X, CENTER_Y);
    }catch(e){ console.warn('startGame: resizeCanvas threw', e); viewWidth = window.innerWidth || 800; viewHeight = window.innerHeight || 600; CENTER_X = Math.round(viewWidth/2); CENTER_Y = Math.round(viewHeight/2); }

    // hide HUD (settings + quick buttons) while playing (best-effort)
    try{ setHUDVisible(false); }catch(e){ console.warn('startGame: setHUDVisible failed', e); }

    // populate demo inventory if empty for testing (non-blocking)
    try{
        if(player.inventory.length===0){
            addToInventory('Air','Common',30);
            addToInventory('Pollen','Common',12);
            addToInventory('Missile','Rare',3);
            addToInventory('Light','Rare',2);
            addToInventory('Stinger','Epic',1);
            console.log('DEBUG startGame: populated demo inventory');
        }
    }catch(e){ console.warn('startGame: populate inventory failed', e); }

    // reset player state for a new run
    try{
        isDead = false;
        player.health = player.maxHealth;
        player.x = CENTER_X; player.y = CENTER_Y;
        // ensure canvas is focusable and get keyboard input
        try{ canvas.tabIndex = canvas.tabIndex || 0; canvas.focus(); }catch(e){}
        mobs=[]; drops=[]; projectiles=[];
        nextEquipIndex = 0;
        refreshPetals();
        console.log('DEBUG startGame: player reset, arrays cleared');
    }catch(e){ console.warn('startGame: player reset failed', e); }

    // log canvas/debug info to console for diagnostics
    try{
        const rect = canvas.getBoundingClientRect();
        console.log('DEBUG startGame: DPR=', window.devicePixelRatio, 'canvas.width=', canvas.width, 'canvas.height=', canvas.height, 'rect=', rect);
    }catch(e){ console.log('DEBUG startGame: error reading canvas rect', e); }

    // ensure any previous animation frame is cancelled before starting
    try{ if(animationId) cancelAnimationFrame(animationId); animationId = null; }catch(e){ console.warn('startGame: cancelAnimationFrame failed', e); }

    // spawn wave and start loop; keep these as the last critical steps so UI failures won't block gameplay
    try{
        spawnWave(currentWave);
        console.log('DEBUG startGame: spawnWave called, mobs=', mobs.length);
    }catch(e){ console.error('startGame: spawnWave failed', e); mobs = []; }

    try{ if(window.renderInventory) window.renderInventory(); }catch(e){}

    try{
        gameLoop();
        console.log('DEBUG startGame: gameLoop started');
    }catch(e){ console.error('startGame: gameLoop failed to start', e); }
};

// (removed DOM debug overlay - diagnostics kept in console)

// --- RARITY SYSTEM ---
const RARITY_NAMES = [
    'Common','Unusual','Rare','Epic','Legendary','Mythical','Ultra','Super','Radiant','Mystitic','Runic','Seraphic','Umbral','Impracticality'
];
const RARITY_COLOR = {
    Common: '#bfeecb',       // Light Green
    Unusual: '#fff9c4',      // Light Yellow
    Rare: '#3b6cff',         // Blue
    Epic: '#d6b3ff',         // Light Purple
    Legendary: '#800000',    // Maroon
    Mythical: '#5fd6d1',     // Light Blue / Teal
    Ultra: '#ff4db8',        // Hot Pink
    Super: '#00c9a7',        // Cyan Green
    Radiant: '#ffd24d',      // Gold / Bright Yellow
    Mystitic: '#30e0d0',     // Turquoise
    Runic: '#2b2b7a',        // Deep Indigo
    Seraphic: '#ffffff',     // White / Pearl
    Umbral: '#000000',       // Black / Void
    Impracticality: null     // Shifting rainbow / cosmic handled separately
};

// Spawn probability table per rarity by wave ranges.
const RARITY_SPAWN_TABLE = [
    // Wave 1-3
    [50,25,12,6,3,2,1,0.5,0.3,0.2,0.1,0.05,0.01,0.01],
    // Wave 4-6
    [40,25,15,8,5,4,2,1,0.5,0.3,0.2,0.1,0.05,0.05],
    // Wave 7-9
    [30,20,20,10,8,6,3,2,1,0.5,0.3,0.2,0.1,0.1],
    // Wave 10+
    [20,15,20,10,10,8,5,4,2,1,0.5,0.3,0.2,0.2]
];

function getRarityDistributionForWave(wave){
    if(wave <= 3) return RARITY_SPAWN_TABLE[0].slice();
    if(wave <= 6) return RARITY_SPAWN_TABLE[1].slice();
    if(wave <= 9) return RARITY_SPAWN_TABLE[2].slice();
    return RARITY_SPAWN_TABLE[3].slice();
}

function pickRarityByWave(wave){
    const dist = getRarityDistributionForWave(wave);
    // normalize and weighted pick
    const total = dist.reduce((a,b)=>a+b,0);
    if(total <= 0) return 'Common';
    let r = Math.random() * total;
    for(let i=0;i<dist.length;i++){
        r -= dist[i];
        if(r <= 0) return RARITY_NAMES[i] || 'Common';
    }
    return RARITY_NAMES[RARITY_NAMES.length-1];
}

function hexToRgb(hex){
    if(!hex) return null;
    hex = hex.replace('#','');
    if(hex.length===3) hex = hex.split('').map(c=>c+c).join('');
    const bigint = parseInt(hex,16); return {r:(bigint>>16)&255, g:(bigint>>8)&255, b:bigint&255};
}
function luminanceOfHex(hex){ const rgb = hexToRgb(hex); if(!rgb) return 0; const r = rgb.r/255, g = rgb.g/255, b = rgb.b/255; return 0.2126*r + 0.7152*g + 0.0722*b; }
function contrastColor(hex){ const lum = luminanceOfHex(hex||'#000'); return (lum > 0.6) ? '#000' : '#fff'; }

// helper to build rounded rect path (stroke/fill externally)
function roundRectPath(ctx, x, y, width, height, radius){
    const r = Math.min(radius, width/2, height/2);
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + width, y, x + width, y + height, r);
    ctx.arcTo(x + width, y + height, x, y + height, r);
    ctx.arcTo(x, y + height, x, y, r);
    ctx.arcTo(x, y, x + width, y, r);
    ctx.closePath();
}

const RARITY_BASE_MULTIPLIER = 1.55; // exponential base for scaling; higher -> wider gaps between rarities
function rarityMultiplier(index){ return Math.pow(RARITY_BASE_MULTIPLIER, Math.max(0, index)); }

// --- SIMPLE CHAT SYSTEM (client-side) ---
// Creates a small chat overlay with message area and input. Press Enter to focus/send.
(function(){
    try{
        // build chat root
        const cr = document.createElement('div'); cr.id = 'chatRoot';
        cr.style.position = 'fixed'; cr.style.left = '12px'; cr.style.bottom = '12px'; cr.style.width = '360px'; cr.style.maxHeight = '40vh'; cr.style.zIndex = 99999; cr.style.display = 'flex'; cr.style.flexDirection = 'column'; cr.style.gap = '6px'; cr.style.fontFamily = 'Arial, sans-serif';
        cr.style.pointerEvents = 'auto';

        const msgs = document.createElement('div'); msgs.id = 'chatMessages'; msgs.style.background = 'rgba(8,8,12,0.6)'; msgs.style.color = '#fff'; msgs.style.padding = '8px'; msgs.style.borderRadius = '8px'; msgs.style.overflowY = 'auto'; msgs.style.flex = '1 1 auto'; msgs.style.maxHeight = '40vh'; msgs.style.fontSize = '13px'; msgs.style.boxShadow = '0 6px 18px rgba(0,0,0,0.5)';
        cr.appendChild(msgs);

        const inputWrap = document.createElement('div'); inputWrap.style.display = 'flex'; inputWrap.style.gap = '6px';
        const input = document.createElement('input'); input.id = 'chatInput'; input.type = 'text'; input.placeholder = 'Press Enter to chat — use $spawnmob or $setwave';
        input.style.flex = '1 1 auto'; input.style.padding = '8px 10px'; input.style.borderRadius = '6px'; input.style.border = '1px solid rgba(255,255,255,0.12)'; input.style.background = 'rgba(255,255,255,0.04)'; input.style.color = '#fff';
        const sendBtn = document.createElement('button'); sendBtn.textContent = 'Send'; sendBtn.style.padding = '8px 10px'; sendBtn.style.borderRadius = '6px'; sendBtn.style.border = 'none'; sendBtn.style.background = '#3b82f6'; sendBtn.style.color = '#fff';
        inputWrap.appendChild(input); inputWrap.appendChild(sendBtn);
        cr.appendChild(inputWrap);

        document.addEventListener('DOMContentLoaded', ()=>{ document.body.appendChild(cr); });
        if(document.body) document.body.appendChild(cr);

        function appendMsg(text, cls){
            try{
                const el = document.createElement('div'); el.style.marginBottom = '6px'; el.style.wordBreak = 'break-word';
                el.innerHTML = text;
                if(cls === 'system') el.style.opacity = '0.9';
                msgs.appendChild(el);
                msgs.scrollTop = msgs.scrollHeight;
            }catch(e){}
        }

        function spawnMobCommand(name, rarityArg){
            try{
                if(!name) { appendMsg('<em>spawnmob requires a name</em>','system'); return; }
                let rarityName = 'Common';
                if(typeof rarityArg === 'number'){ const i = Math.max(0, Math.min(RARITY_NAMES.length-1, rarityArg)); rarityName = RARITY_NAMES[i]; }
                else if(typeof rarityArg === 'string' && rarityArg.trim().length>0){ const maybe = rarityArg.trim(); if(/^[0-9]+$/.test(maybe)) rarityName = RARITY_NAMES[Math.max(0, Math.min(RARITY_NAMES.length-1, parseInt(maybe)))]; else rarityName = maybe; }

                const rarityIndex = Math.max(0, RARITY_NAMES.indexOf(rarityName));
                const mult = rarityMultiplier(rarityIndex);
                const x = Math.max(0, Math.min(viewWidth, player.x + (Math.random()*400 - 200)));
                const y = Math.max(0, Math.min(viewHeight, player.y + (Math.random()*400 - 200)));
                const radius = Math.max(8, Math.round(12 * (1 + rarityIndex*0.06)));
                const hp = Math.max(6, Math.round(30 * mult));
                const speed = Math.max(0.2, 1.2 - (rarityIndex*0.02));
                mobs.push({ x, y, radius, speed, health: hp, maxHealth: hp, name: name, type: name, projectiles: [], shootCooldown: 0, rarityIndex, rarityName, stationary: false, mass: Math.round(radius * (1 + rarityIndex*0.06)), vx:0, vy:0 });
                appendMsg(`<strong>Spawned</strong> ${name} (${rarityName}) near player`,'system');
            }catch(e){ appendMsg('<em>spawn failed</em>','system'); }
        }

        function setWaveCommand(n){
            try{
                const val = parseInt(n,10);
                if(isNaN(val) || val < 1){ appendMsg('<em>invalid wave number</em>','system'); return; }
                currentWave = val;
                spawnWave(currentWave);
                appendMsg(`<strong>Wave set to</strong> ${currentWave}`,'system');
            }catch(e){ appendMsg('<em>setwave failed</em>','system'); }
        }

        function handleChatLine(line){
            if(!line) return;
            const trimmed = line.trim();
            if(trimmed.length === 0) return;
            // commands start with $
            if(trimmed.startsWith('$')){
                const parts = trimmed.split(/\s+/);
                const cmd = parts[0].toLowerCase();
                if(cmd === '$spawnmob'){
                    if(parts.length < 3){ appendMsg('<em>Usage: $spawnmob &lt;name&gt; &lt;rarity-number&gt;</em>','system'); return; }
                    const name = parts[1]; const r = parts[2]; spawnMobCommand(name, r);
                    return;
                } else if(cmd === '$setwave'){
                    if(parts.length < 2){ appendMsg('<em>Usage: $setwave &lt;number&gt;</em>','system'); return; }
                    setWaveCommand(parts[1]); return;
                } else {
                    appendMsg(`<em>Unknown command:</em> ${cmd}`,'system'); return;
                }
            }
            // normal chat echo (client-only)
            appendMsg(`<strong>You:</strong> ${escapeHtml(trimmed)}`);
        }

        function escapeHtml(s){ return String(s).replace(/[&<>\"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":"&#39;"}[c]; }); }

        sendBtn.addEventListener('click', ()=>{ const v = input.value || ''; handleChatLine(v); input.value=''; input.focus(); });
        input.addEventListener('keydown', function(e){ if(e.key === 'Enter'){ e.preventDefault(); const v = input.value || ''; handleChatLine(v); input.value=''; input.blur(); } });

        // Pressing Enter anywhere should focus the chat input (unless typing in a field already)
        document.addEventListener('keydown', function(e){
            try{
                if(e.key === 'Enter'){
                    const active = document.activeElement;
                    if(active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) return;
                    input.focus(); e.preventDefault();
                }
            }catch(err){}
        });

        // expose commands for external use
        window.chatCommands = { spawnMob: spawnMobCommand, setWave: setWaveCommand, appendMsg };
        // small welcome
        appendMsg('<em>Chat initialized. Use <strong>$spawnmob &lt;name&gt; &lt;rarity-number&gt;</strong> or <strong>$setwave &lt;number&gt;</strong></em>','system');
    }catch(e){ console.warn('chat init failed', e); }
})();
