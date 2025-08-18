// Supabase Configuration
const SUPABASE_URL = 'https://iaqnxamnjftwqdbsnfyl.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlhcW54YW1uamZ0d3FkYnNuZnlsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTE5NTc5MzQsImV4cCI6MjA2NzUzMzkzNH0.k3G4Tc6U7XdYGmU9wTkcg3R1cLRij-CN6EbjSSbd9bE';

// Initialize Supabase client
const { createClient } = supabase;
const supabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Export the supabase client globally for debugging
window.supabase = supabaseClient;

// Main search function using confirmed table structure: Products with SKU and Code columns
async function searchProduct(searchTerm) {
    const cleanTerm = String(searchTerm).trim();

    const { data, error } = await supabaseClient
        .from('Products')
        .select('*')
        .or(
            `SKU.ilike.%${cleanTerm}%,Code.ilike.%${cleanTerm}%,` +
            `barcode1.ilike.%${cleanTerm}%,barcode2.ilike.%${cleanTerm}%,` +
            `barcode3.ilike.%${cleanTerm}%,barcode4.ilike.%${cleanTerm}%,` +
            `barcode5.ilike.%${cleanTerm}%,barcode6.ilike.%${cleanTerm}%`
        );

    if (error) {
        return { success: false, error: error.message };
    }

    if (!data || data.length === 0) {
        return { success: false, error: 'No products found matching your search', searchTerm: cleanTerm };
    }

    return { success: true, products: data };
}

// Search specifically by SKU
async function searchBySKU(sku) {
    console.log('🔍 Searching by SKU:', sku);
    
    try {
        const { data, error } = await supabaseClient
            .from('Products')
            .select('*')
            .eq('SKU', sku)
            .single();

        if (!error && data) {
            console.log('✅ SKU found:', data);
            return {
                success: true,
                product: {
                    sku: data.SKU || '',
                    code: data.Code || '',
                    name: data.name || data.nome || data.Name || data.Nome || 'Product Name',
                    description: data.description || data.descricao || data.Description || data.Descricao || 'Product Description'
                }
            };
        }
        
        console.log('❌ SKU not found');
        return { success: false, error: 'SKU not found' };
    } catch (error) {
        console.error('❌ Error searching by SKU:', error);
        return { success: false, error: `SKU search failed: ${error.message}` };
    }
}

// Search specifically by Code
async function searchByCode(code) {
    console.log('🔍 Searching by Code:', code);
    
    try {
        const { data, error } = await supabaseClient
            .from('Products')
            .select('*')
            .eq('Code', code)
            .single();

        if (!error && data) {
            console.log('✅ Code found:', data);
            return {
                success: true,
                product: {
                    sku: data.SKU || '',
                    code: data.Code || '',
                    name: data.name || data.nome || data.Name || data.Nome || 'Product Name',
                    description: data.description || data.descricao || data.Description || data.Descricao || 'Product Description'
                }
            };
        }
        
        console.log('❌ Code not found');
        return { success: false, error: 'Code not found' };
    } catch (error) {
        console.error('❌ Error searching by Code:', error);
        return { success: false, error: `Code search failed: ${error.message}` };
    }
}

// Debug function to discover table structure
async function discoverTableStructure() {
    try {
        console.log('🔍 Discovering table structure...');
        
        // Check the Products table
        const { data, error } = await supabaseClient
            .from('Products')
            .select('*')
            .limit(1);

        if (!error && data && data.length > 0) {
            console.log('✅ Products table found!');
            console.log('📊 Table structure:', Object.keys(data[0]));
            console.log('📝 Sample record:', data[0]);
            return {
                tableName: 'Products',
                columns: Object.keys(data[0]),
                sample: data[0]
            };
        } else {
            console.log('❌ Products table not accessible:', error?.message || 'No data');
            return null;
        }
    } catch (error) {
        console.error('❌ Error discovering structure:', error);
        return null;
    }
}

// Export functions for use in other files
window.supabaseSearch = {
    searchProduct,
    searchBySKU,
    searchByCode,
    client: supabaseClient,
    discoverTableStructure
};
