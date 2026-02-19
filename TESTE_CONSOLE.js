// TESTE DIRETO - Cole isso no console do navegador (F12)

console.clear();
console.log('🧪 TESTE CIN7 SIMPLE CACHE\n');

// Teste 1: Verificar se arquivo carregou
console.log('1️⃣ Verificando se cin7SimpleCache está carregado...');
if (typeof cin7SimpleCache !== 'undefined') {
    console.log('✅ cin7SimpleCache EXISTE');
} else {
    console.log('❌ cin7SimpleCache NÃO EXISTE - arquivo não carregou!');
}

// Teste 2: Testar backend diretamente
console.log('\n2️⃣ Testando backend Flask direto...');
fetch('http://localhost:5050/api/cin7/cache/lookup/SO-237147')
    .then(r => r.json())
    .then(d => {
        console.log('✅ Backend respondeu:');
        console.log('   Cliente:', d.delivery_company);
    })
    .catch(e => console.log('❌ Backend erro:', e.message));

// Teste 3: Usar cin7SimpleCache
setTimeout(() => {
    console.log('\n3️⃣ Testando cin7SimpleCache.lookupOrder...');
    if (typeof cin7SimpleCache !== 'undefined') {
        cin7SimpleCache.lookupOrder('237147')
            .then(r => {
                console.log('✅ Resultado:', r);
                console.log('   Cliente:', r.customer_name);
                console.log('   Source:', r.source);
            })
            .catch(e => console.log('❌ Erro:', e));
    }
}, 1000);
