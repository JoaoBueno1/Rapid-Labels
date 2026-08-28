const fs=require('fs'),{Client}=require('./node_modules/pg');
const env=Object.fromEntries(fs.readFileSync('.env','utf8').split('\n').filter(l=>l.includes('=')&&!l.trim().startsWith('#'))
  .map(l=>[l.slice(0,l.indexOf('=')).trim(),l.slice(l.indexOf('=')+1).trim()]));
const c=new Client({host:env.SUPABASE_DB_HOST,port:5432,database:'postgres',
  user:'postgres.iaqnxamnjftwqdbsnfyl',password:env.SUPABASE_DB_PASSWORD,ssl:{rejectUnauthorized:false}});
(async()=>{await c.connect();
 const r=await c.query(`select id, to_char(created_at,'HH24:MI:SS') hora, status,
   coalesce(cin7_number,'—') tr, left(coalesce(error,''),52) motivo
   from rapid_inv.replenishment_order order by created_at`);
 console.log('  LINHA DO TEMPO — todas as tentativas, em ordem'); console.table(r.rows);
 const f=await c.query(`select
   max(created_at) filter (where status='FAILED') ultima_falha,
   min(created_at) filter (where status='ORDERED') primeiro_sucesso`);
 const {ultima_falha,primeiro_sucesso}=f.rows[0];
 console.log('  última falha   :', String(ultima_falha).slice(0,24));
 console.log('  primeiro sucesso:', String(primeiro_sucesso).slice(0,24));
 console.log('  → todas as falhas são ANTERIORES ao primeiro sucesso?',
   new Date(ultima_falha) < new Date(primeiro_sucesso) ? 'SIM ✓' : 'NÃO ⚠');
 await c.end()})().catch(e=>console.log('ERRO',e.message));
