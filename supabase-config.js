// Supabase Configuration
// IMPORTANT: Replace the variables below with your Supabase credentials

const SUPABASE_URL = 'https://iaqnxamnjftwqdbsnfyl.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlhcW54YW1uamZ0d3FkYnNuZnlsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTE5NTc5MzQsImV4cCI6MjA2NzUzMzkzNH0.k3G4Tc6U7XdYGmU9wTkcg3R1cLRij-CN6EbjSSbd9bE';

// Initialize Supabase client
const { createClient } = supabase;
const supabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Export the supabase client globally for debugging
window.supabase = supabaseClient;

// Main search function using confirmed table structure: Products with SKU and Code columns
async function searchProduct(searchTerm) {
    console.log('🔍 Searching for:', searchTerm);
    
    if (!searchTerm || searchTerm.trim() === '') {
        console.log('❌ Empty search term');
        return { success: false, error: 'Search term is required' };
    }

    try {
        console.log('🔄 Searching in Products table with SKU and Code columns');
        
        const { data, error, count } = await supabaseClient
            .from('Products')
            .select('*', { count: 'exact' })
            .or(`SKU.ilike.%${searchTerm}%,Code.ilike.%${searchTerm}%`)
            .limit(10);

        if (error) {
            console.log('❌ Database error:', error.message);
            return { 
                success: false, 
                error: `Database error: ${error.message}`,
                searchTerm: searchTerm
            };
        }

        console.log(`✅ Query successful! Found ${count} total matches`);
        console.log('📊 Data:', data);

        if (data && data.length > 0) {
            // Found results, return the first match
            const product = data[0];
            console.log('🎯 Selected product:', product);
            
            return {
                success: true,
                product: {
                    sku: product.SKU || '',
                    code: product.Code || '',
                    name: product.name || product.nome || product.Name || product.Nome || 'Product Name',
                    description: product.description || product.descricao || product.Description || product.Descricao || 'Product Description'
                }
            };
        } else {
            console.log('ℹ️ No products found matching the search term');
            return { 
                success: false, 
                error: 'No products found matching your search',
                searchTerm: searchTerm
            };
        }

    } catch (err) {
        console.log('� Exception during search:', err.message);
        return { 
            success: false, 
            error: `Search failed: ${err.message}`,
            searchTerm: searchTerm
        };
    }
}

// Search specifically by SKU
async function searchBySKU(sku) {
    try {
        console.log('🔍 Searching by SKU:', sku);
        
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
    try {
        console.log('🔍 Searching by Code:', code);
        
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
