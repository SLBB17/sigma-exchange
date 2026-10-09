
require('dotenv').config();
const path=require('path');
const express=require('express');
const session=require('express-session');
const bcrypt=require('bcryptjs');
const {Pool}=require('pg');

const app=express();
const PORT=Number(process.env.PORT||3000),HOST=process.env.HOST||'0.0.0.0';
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: {
        rejectUnauthorized: false
      }
    })
  : new Pool({
      host: process.env.PGHOST || '127.0.0.1',
      port: Number(process.env.PGPORT || 5432),
      database: process.env.PGDATABASE || 'sigma_banque',
      user: process.env.PGUSER || 'postgres',
      password: String(process.env.PGPASSWORD || '')
    });

const TITLES={footeux:'Footeux',footballeur:'Footballeur',shooter:'Shooter',survivor:'Survivor',calculateur:'Calculateur',clavier:'Clavier',chanceux:'Chanceux',devineur:'Devineur',entrepreneur:'Entrepreneur',banquier:'Banquier',magnat:'Magnat',commercant:'Commerçant',investisseur:'Investisseur',millionaire:'Millionnaire',patron:'Patron',directeur:'Directeur',visionnaire:'Visionnaire',negociateur:'Négociateur',trader:'Trader',vip:'VIP',legendaire:'Légendaire'};
const ITEMS={chat_access:{name:'Accès au chat',price:10,description:'Débloque le chat.'},premium_card:{name:'Carte Premium',price:75,description:'+25 % sur les revenus.'},golden_profile:{name:'Profil doré',price:150,description:'Active le thème doré.'},arcade_pass:{name:'Pass Arcade',price:250,description:'Débloque les jeux.'},safe_box:{name:'Coffre-fort',price:600,description:'Solde séparé.'}};
const SHOP_TITLES={entrepreneur:{name:'Entrepreneur',price:300},banquier:{name:'Banquier',price:750},magnat:{name:'Magnat',price:2000},commercant:{name:'Commerçant',price:120},investisseur:{name:'Investisseur',price:450},millionaire:{name:'Millionnaire',price:5000},patron:{name:'Patron',price:900},directeur:{name:'Directeur',price:1400},visionnaire:{name:'Visionnaire',price:1800},negociateur:{name:'Négociateur',price:650},trader:{name:'Trader',price:1200},vip:{name:'VIP',price:2500},legendaire:{name:'Légendaire',price:10000}};
const SOURCES={lemonade:{name:'Stand de limonade',price:100,daily:5},webshop:{name:'Boutique en ligne',price:500,daily:20},cafe:{name:'Café',price:1200,daily:55},farm:{name:'Ferme',price:3000,daily:130},transport:{name:'Entreprise de transport',price:6500,daily:300},football_club:{name:'Club de football',price:0,daily:75,game:true},gaming_studio:{name:'Studio de jeux vidéo',price:0,daily:650,game:true},software_company:{name:'Entreprise logicielle',price:0,daily:900,game:true}};

const q=(s,p=[])=>pool.query(s,p), one=async(s,p=[])=>(await q(s,p)).rows[0]||null;
const money=v=>{let n=Number(v);return Number.isFinite(n)&&n>0?Math.round(n*100)/100:0};
async function schema(){
 await q(`CREATE TABLE IF NOT EXISTS users(id SERIAL PRIMARY KEY,username TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,first_name TEXT NOT NULL,last_name TEXT NOT NULL,email TEXT NOT NULL DEFAULT '',phone TEXT NOT NULL DEFAULT '',balance NUMERIC(14,2) NOT NULL DEFAULT 500,vault_balance NUMERIC(14,2) NOT NULL DEFAULT 0,selected_title_key TEXT NOT NULL DEFAULT '',is_admin BOOLEAN NOT NULL DEFAULT FALSE,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
 CREATE TABLE IF NOT EXISTS transfers(id SERIAL PRIMARY KEY,sender_id INT REFERENCES users(id) ON DELETE CASCADE,receiver_id INT REFERENCES users(id) ON DELETE CASCADE,amount NUMERIC(14,2) NOT NULL,reason TEXT NOT NULL DEFAULT '',created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
 CREATE TABLE IF NOT EXISTS chat_messages(id SERIAL PRIMARY KEY,user_id INT REFERENCES users(id) ON DELETE CASCADE,message TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
 CREATE TABLE IF NOT EXISTS user_entitlements(user_id INT REFERENCES users(id) ON DELETE CASCADE,item_key TEXT NOT NULL,PRIMARY KEY(user_id,item_key));
 CREATE TABLE IF NOT EXISTS user_titles(user_id INT REFERENCES users(id) ON DELETE CASCADE,title_key TEXT NOT NULL,PRIMARY KEY(user_id,title_key));
 CREATE TABLE IF NOT EXISTS user_income_sources(user_id INT REFERENCES users(id) ON DELETE CASCADE,source_key TEXT NOT NULL,last_claim_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),PRIMARY KEY(user_id,source_key));`);
 await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE`);
 let a=await one(`SELECT id FROM users WHERE username='admin'`);
 if(!a) await q(`INSERT INTO users(username,password_hash,first_name,last_name,email,phone,balance,is_admin) VALUES($1,$2,'Administrateur','Sigma','admin@example.test','0000000000',5000,TRUE)`,['admin',await bcrypt.hash(process.env.ADMIN_PASSWORD||'admin123',10)]);
 else await q(`UPDATE users SET is_admin=TRUE WHERE username='admin'`);
}
async function user(id){return one('SELECT * FROM users WHERE id=$1',[id])}
async function has(id,k){return !!await one('SELECT 1 FROM user_entitlements WHERE user_id=$1 AND item_key=$2',[id,k])}
async function titleHas(id,k){return !!await one('SELECT 1 FROM user_titles WHERE user_id=$1 AND title_key=$2',[id,k])}
async function sourceHas(id,k){return !!await one('SELECT 1 FROM user_income_sources WHERE user_id=$1 AND source_key=$2',[id,k])}
async function addTitle(id,k){if(!TITLES[k]||await titleHas(id,k))return false;await q('INSERT INTO user_titles(user_id,title_key) VALUES($1,$2) ON CONFLICT DO NOTHING',[id,k]);return true}
async function addSource(id,k){if(!SOURCES[k]||await sourceHas(id,k))return false;await q('INSERT INTO user_income_sources(user_id,source_key) VALUES($1,$2) ON CONFLICT DO NOTHING',[id,k]);return true}
async function claimIncome(id){let rows=(await q('SELECT source_key,last_claim_at FROM user_income_sources WHERE user_id=$1',[id])).rows,total=0,premium=await has(id,'premium_card');for(let r of rows){let d=SOURCES[r.source_key],days=Math.floor((Date.now()-new Date(r.last_claim_at).getTime())/86400000);if(d&&days>0){let a=days*d.daily*(premium?1.25:1);total+=a;await q('UPDATE users SET balance=balance+$1 WHERE id=$2',[a,id]);await q('UPDATE user_income_sources SET last_claim_at=NOW() WHERE user_id=$1 AND source_key=$2',[id,r.source_key])}}return total}
async function pub(u){if(!u)return null;return {id:u.id,username:u.username,firstName:u.first_name,lastName:u.last_name,email:u.email,phone:u.phone,balance:Number(u.balance),vaultBalance:Number(u.vault_balance),selectedTitleKey:u.selected_title_key,selectedTitle:TITLES[u.selected_title_key]||'',isAdmin:!!u.is_admin,premium:await has(u.id,'premium_card'),goldenProfile:await has(u.id,'golden_profile'),arcadePass:await has(u.id,'arcade_pass'),safeBox:await has(u.id,'safe_box')}}
const login=(req,res,next)=>req.session.userId?next():res.status(401).json({error:'Connexion requise.'});
const admin=async(req,res,next)=>{let u=await user(req.session.userId);return u?.is_admin?next():res.status(403).json({error:'Accès administrateur requis.'})};
app.use(express.json());app.use(session({secret:process.env.SESSION_SECRET||'change-me',resave:false,saveUninitialized:false}));app.use(express.static(path.join(__dirname,'public')));

app.post('/api/register',async(req,res)=>{try{let b=req.body||{},ks=['username','password','firstName','lastName','email','phone'];if(!ks.every(k=>String(b[k]||'').trim()))throw Error('Tous les champs sont obligatoires.');let name=String(b.username).trim();if(name.toLowerCase()==='admin')throw Error('Identifiant réservé.');if(await one('SELECT id FROM users WHERE LOWER(username)=LOWER($1)',[name]))throw Error('Identifiant déjà utilisé.');let u=await one('INSERT INTO users(username,password_hash,first_name,last_name,email,phone,balance) VALUES($1,$2,$3,$4,$5,$6,500) RETURNING *',[name,await bcrypt.hash(String(b.password),10),b.firstName,b.lastName,b.email,b.phone]);req.session.userId=u.id;res.json({user:await pub(u)})}catch(e){res.status(400).json({error:e.message})}});
app.post('/api/login',async(req,res)=>{let u=await one('SELECT * FROM users WHERE LOWER(username)=LOWER($1)',[String(req.body?.username||'').trim()]);if(!u||!await bcrypt.compare(String(req.body?.password||''),u.password_hash))return res.status(401).json({error:'Identifiant ou mot de passe incorrect.'});req.session.userId=u.id;res.json({user:await pub(u)})});
app.post('/api/logout',(req,res)=>req.session.destroy(()=>res.json({ok:true})));
app.get('/api/me',login,async(req,res)=>{await claimIncome(req.session.userId);res.json({user:await pub(await user(req.session.userId))})});
app.get('/api/users',login,async(req,res)=>res.json({users:(await q('SELECT id,username,first_name,last_name FROM users WHERE id<>$1 ORDER BY username',[req.session.userId])).rows}));
app.post('/api/transfers',login,async(req,res)=>{let to=Number(req.body.to),a=money(req.body.amount),s=await user(req.session.userId),r=await user(to);if(!a)throw Error('Montant invalide.');if(!r)throw Error('Destinataire introuvable.');if(Number(s.balance)<a)return res.status(400).json({error:'Solde insuffisant.'});await q('UPDATE users SET balance=balance-$1 WHERE id=$2',[a,s.id]);await q('UPDATE users SET balance=balance+$1 WHERE id=$2',[a,r.id]);await q('INSERT INTO transfers(sender_id,receiver_id,amount,reason) VALUES($1,$2,$3,$4)',[s.id,r.id,a,String(req.body.reason||'')]);res.json({message:'Virement effectué.',user:await pub(await user(s.id))})});
app.get('/api/transactions',login,async(req,res)=>{let rows=(await q(`SELECT t.*,s.username sender,r.username receiver FROM transfers t JOIN users s ON s.id=t.sender_id JOIN users r ON r.id=t.receiver_id WHERE sender_id=$1 OR receiver_id=$1 ORDER BY created_at DESC`,[req.session.userId])).rows;res.json({transactions:rows.map(x=>({createdAt:x.created_at,type:x.sender_id===req.session.userId?'Envoyé':'Reçu',amount:Number(x.amount),message:x.reason}))})});
app.get('/api/shop',login,async(req,res)=>{let id=req.session.userId;res.json({items:await Promise.all(Object.entries(ITEMS).map(async([key,v])=>({key,...v,bought:await has(id,key)}))),titles:await Promise.all(Object.entries(SHOP_TITLES).map(async([key,v])=>({key,...v,bought:await titleHas(id,key)}))),sources:await Promise.all(Object.entries(SOURCES).map(async([key,v])=>({key,...v,owned:await sourceHas(id,key)})))})});
app.post('/api/shop/buy',login,async(req,res)=>{try{let kind=String(req.body?.kind||''),key=String(req.body?.key||''),d=kind==='item'?ITEMS[key]:kind==='title'?SHOP_TITLES[key]:kind==='source'?SOURCES[key]:null;if(!d)throw Error('Article introuvable.');if(d.game)throw Error('Cette source se débloque avec un mini-jeu.');let u=await user(req.session.userId),owned=kind==='item'?await has(u.id,key):kind==='title'?await titleHas(u.id,key):await sourceHas(u.id,key);if(owned)throw Error('Déjà obtenu.');if(Number(u.balance)<d.price)throw Error('Solde insuffisant.');await q('UPDATE users SET balance=balance-$1 WHERE id=$2',[d.price,u.id]);if(kind==='item')await q('INSERT INTO user_entitlements(user_id,item_key) VALUES($1,$2)',[u.id,key]);else if(kind==='title')await addTitle(u.id,key);else await addSource(u.id,key);res.json({user:await pub(await user(u.id))})}catch(e){res.status(400).json({error:e.message})}});
app.get('/api/titles',login,async(req,res)=>{let rows=(await q('SELECT title_key FROM user_titles WHERE user_id=$1',[req.session.userId])).rows;res.json({titles:rows.map(x=>({key:x.title_key,name:TITLES[x.title_key]}))})});
app.post('/api/profile/title',login,async(req,res)=>{let k=String(req.body.titleKey||'');if(k&&!await titleHas(req.session.userId,k))return res.status(400).json({error:'Titre non possédé.'});await q('UPDATE users SET selected_title_key=$1 WHERE id=$2',[k,req.session.userId]);res.json({user:await pub(await user(req.session.userId))})});
app.get('/api/income',login,async(req,res)=>{let rows=(await q('SELECT source_key FROM user_income_sources WHERE user_id=$1',[req.session.userId])).rows;res.json({sources:rows.map(x=>({key:x.source_key,...SOURCES[x.source_key]}))})});
app.put('/api/profile',login,async(req,res)=>{let b=req.body;await q('UPDATE users SET first_name=$1,last_name=$2,email=$3,phone=$4 WHERE id=$5',[b.firstName,b.lastName,b.email,b.phone,req.session.userId]);res.json({user:await pub(await user(req.session.userId))})});
app.post('/api/vault/:action',login,async(req,res)=>{try{let id=req.session.userId,a=money(req.body.amount),u=await user(id);if(!await has(id,'safe_box'))throw Error('Achète le Coffre-fort.');if(!a)throw Error('Montant invalide.');if(req.params.action==='deposit'){if(Number(u.balance)<a)throw Error('Solde insuffisant.');await q('UPDATE users SET balance=balance-$1,vault_balance=vault_balance+$1 WHERE id=$2',[a,id])}else{if(Number(u.vault_balance)<a)throw Error('Le coffre ne contient pas assez d’argent.');await q('UPDATE users SET balance=balance+$1,vault_balance=vault_balance-$1 WHERE id=$2',[a,id])}res.json({user:await pub(await user(id))})}catch(e){res.status(400).json({error:e.message})}});
async function chatOK(id){return (await user(id)).is_admin||await has(id,'chat_access')}
app.get('/api/chat',login,async(req,res)=>{if(!await chatOK(req.session.userId))return res.status(403).json({error:'Le chat coûte 10 € dans la boutique.'});let rows=(await q(`SELECT c.message,u.username,u.selected_title_key FROM chat_messages c JOIN users u ON u.id=c.user_id ORDER BY c.id DESC LIMIT 100`)).rows.reverse();res.json({messages:rows.map(x=>({...x,title:TITLES[x.selected_title_key]||''}))})});
app.post('/api/chat',login,async(req,res)=>{if(!await chatOK(req.session.userId))return res.status(403).json({error:'Le chat coûte 10 € dans la boutique.'});let m=String(req.body.message||'').trim();if(!m)return res.status(400).json({error:'Message invalide.'});await q('INSERT INTO chat_messages(user_id,message) VALUES($1,$2)',[req.session.userId,m]);res.json({ok:true})});
app.get('/api/games',login,(req,res)=>res.json({games:[{id:'football',name:'⚽ Football',description:'Récompenses football.'},{id:'shooter',name:'🎯 Tir',description:'5 réussites : Shooter, 5 ratés : Survivor.'},{id:'math',name:'➗ Maths',description:'Débloque Calculateur.'},{id:'typing',name:'⌨️ Clavier',description:'Débloque Studio.'},{id:'coin',name:'🪙 Chance',description:'Débloque Chanceux.'},{id:'guess',name:'🔢 Nombre',description:'Récompense aléatoire.'}]}));
app.post('/api/games/play',login,async(req,res)=>{try{
let id=req.session.userId;if(!await has(id,'arcade_pass'))throw Error('Achète le Pass Arcade.');
let g=String(req.body.gameId||''),ok=!!req.body.success,reward=ok?15:0,unlocked=[];
if(!['football','shooter','math','typing','coin','guess'].includes(g))throw Error('Jeu introuvable.');
if(g==='football'&&ok){if(await addTitle(id,'footeux'))unlocked.push('Footeux');req.session.footballWins=(req.session.footballWins||0)+1;if(req.session.footballWins>=3){if(await addTitle(id,'footballeur'))unlocked.push('Footballeur');if(await addSource(id,'football_club'))unlocked.push('Club de football')}}
if(g==='shooter'){req.session.sw=(req.session.sw||0)+(ok?1:0);req.session.sl=(req.session.sl||0)+(ok?0:1);if(req.session.sw>=5&&await addTitle(id,'shooter'))unlocked.push('Shooter');if(req.session.sl>=5&&await addTitle(id,'survivor'))unlocked.push('Survivor')}
if(g==='math'&&ok){if(await addTitle(id,'calculateur'))unlocked.push('Calculateur');if(await addSource(id,'software_company'))unlocked.push('Entreprise logicielle')}
if(g==='typing'&&ok){if(await addTitle(id,'clavier'))unlocked.push('Clavier');if(await addSource(id,'gaming_studio'))unlocked.push('Studio de jeux vidéo')}
if(g==='coin'&&ok&&await addTitle(id,'chanceux'))unlocked.push('Chanceux');
if(g==='guess'&&ok&&await addTitle(id,'devineur'))unlocked.push('Devineur');
if(reward)await q('UPDATE users SET balance=balance+$1 WHERE id=$2',[reward,id]);
res.json({ok,reward,unlocked,message:ok?'Réussite !':'Raté, réessaie.',user:await pub(await user(id))})
}catch(e){res.status(400).json({error:e.message})}});
app.get('/api/admin/users',login,admin,async(req,res)=>{let rows=(await q('SELECT id,username,first_name,last_name,email,phone,balance,is_admin FROM users ORDER BY id')).rows;res.json({users:rows.map(u=>({id:u.id,username:u.username,firstName:u.first_name,lastName:u.last_name,email:u.email,phone:u.phone,balance:Number(u.balance),isAdmin:u.is_admin}))})});
app.put('/api/admin/users/:id',login,admin,async(req,res)=>{try{let id=Number(req.params.id),b=req.body,bal=Number(b.balance);if(!Number.isFinite(bal)||bal<0)throw Error('Solde invalide.');await q('UPDATE users SET username=$1,first_name=$2,last_name=$3,email=$4,phone=$5,balance=$6 WHERE id=$7',[b.username,b.firstName,b.lastName,b.email,b.phone,bal,id]);res.json({ok:true})}catch(e){res.status(400).json({error:e.message})}});
app.get('/{*splat}',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
schema().then(()=>app.listen(PORT,HOST,()=>console.log(`Sigma Banque : http://localhost:${PORT}`))).catch(e=>{console.error('Impossible de démarrer PostgreSQL:',e.message);process.exit(1)});
