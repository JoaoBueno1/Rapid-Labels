// Configuração do Supabase
// IMPORTANTE: Substitua as variáveis abaixo pelas suas credenciais do Supabase

const SUPABASE_URL = 'YOUR_SUPABASE_URL'; // Ex: https://xyzcompany.supabase.co
const SUPABASE_ANON_KEY = 'YOUR_SUPABASE_ANON_KEY'; // Sua chave pública do Supabase

// Inicializar cliente Supabase
const { createClient } = supabase;
const supabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Função para buscar produtos por SKU ou CODE
async function searchProducts(searchTerm) {
    try {
        // Busca tanto por SKU quanto por CODE
        const { data, error } = await supabaseClient
            .from('Palltes Labels') // Nome da sua tabela
            .select('*')
            .or(`sku.ilike.%${searchTerm}%,code.ilike.%${searchTerm}%`)
            .limit(10); // Limita a 10 resultados para performance

        if (error) {
            console.error('Erro ao buscar produtos:', error);
            return [];
        }

        return data || [];
    } catch (error) {
        console.error('Erro na conexão com Supabase:', error);
        return [];
    }
}

// Função para buscar produto específico por SKU (para scanner)
async function searchBySKU(sku) {
    try {
        const { data, error } = await supabaseClient
            .from('Palltes Labels')
            .select('*')
            .eq('sku', sku)
            .single(); // Retorna apenas um resultado

        if (error) {
            console.error('Erro ao buscar por SKU:', error);
            return null;
        }

        return data;
    } catch (error) {
        console.error('Erro na busca por SKU:', error);
        return null;
    }
}

// Função para buscar produto específico por CODE
async function searchByCode(code) {
    try {
        const { data, error } = await supabaseClient
            .from('Palltes Labels')
            .select('*')
            .eq('code', code)
            .single();

        if (error) {
            console.error('Erro ao buscar por CODE:', error);
            return null;
        }

        return data;
    } catch (error) {
        console.error('Erro na busca por CODE:', error);
        return null;
    }
}

// Exportar funções para uso em outros arquivos
window.supabaseSearch = {
    searchProducts,
    searchBySKU,
    searchByCode,
    client: supabaseClient
};
