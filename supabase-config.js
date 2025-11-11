// Supabase Configuration
const SUPABASE_URL = 'https://iaqnxamnjftwqdbsnfyl.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlhcW54YW1uamZ0d3FkYnNuZnlsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTE5NTc5MzQsImV4cCI6MjA2NzUzMzkzNH0.k3G4Tc6U7XdYGmU9wTkcg3R1cLRij-CN6EbjSSbd9bE';

// Expose a readiness promise so other scripts can await client availability
window.supabaseReady = (async () => {
  try {
    // Prefer global library if present (in case a CDN UMD build is available)
    let createClientFn = null;
    if (typeof window.supabase !== 'undefined' && typeof window.supabase.createClient === 'function') {
      createClientFn = window.supabase.createClient;
    } else {
      // Dynamically import ESM build from a CDN
      const mod = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
      createClientFn = mod.createClient;
    }

    const supabaseClient = createClientFn(SUPABASE_URL, SUPABASE_ANON_KEY);
    // Keep a handy global reference (used by self-test truthiness)
    window.supabase = supabaseClient;

    // Attach search helpers
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

    async function searchBySKU(sku) {
        console.log('🔍 Searching by SKU:', sku);
        try {
            const { data, error } = await supabaseClient
                .from('Products')
                .select('*')
                .eq('SKU', sku)
                .limit(50);
            if (error) {
                console.error('❌ SKU query error:', error);
                return { success: false, error: error.message || 'SKU query failed' };
            }
            if (Array.isArray(data) && data.length > 0) {
                const row = data[0]; // pick first when duplicates exist
                console.log('✅ SKU found (first match):', row);
                return {
                    success: true,
                    product: {
                        sku: row.SKU || '',
                        code: row.Code || '',
                        name: row.name || row.nome || row.Name || row.Nome || 'Product Name',
                        description: row.description || row.descricao || row.Description || row.Descricao || 'Product Description'
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

    async function searchBySKUAndCode(sku, code) {
        console.log('🔍 Searching by SKU and Code:', sku, code);
        try {
            const { data, error } = await supabaseClient
                .from('Products')
                .select('*')
                .eq('SKU', sku)
                .eq('Code', code)
                .limit(1);
            if (error) {
                console.error('❌ SKU+Code query error:', error);
                return { success: false, error: error.message || 'Product query failed' };
            }
            if (Array.isArray(data) && data.length > 0) {
                const row = data[0];
                console.log('✅ Product found by SKU+Code:', row);
                return {
                    success: true,
                    product: {
                        sku: row.SKU || '',
                        code: row.Code || '',
                        name: row.name || row.nome || row.Name || row.Nome || 'Product Name',
                        description: row.description || row.descricao || row.Description || row.Descricao || 'Product Description'
                    }
                };
            }
            console.log('❌ Product not found with SKU+Code combination');
            return { success: false, error: 'Product not found' };
        } catch (error) {
            console.error('❌ Error searching by SKU and Code:', error);
            return { success: false, error: `Product search failed: ${error.message}` };
        }
    }

    async function searchByCode(code) {
        console.log('🔍 Searching by Code:', code);
        try {
            const { data, error } = await supabaseClient
                .from('Products')
                .select('*')
                .eq('Code', code)
                .limit(50);
            if (error) {
                console.error('❌ Code query error:', error);
                return { success:false, error: error.message || 'Code query failed' };
            }
            if (Array.isArray(data) && data.length > 0) {
                const row = data[0]; // pick first when duplicates exist
                console.log('✅ Code found (first match):', row);
                return {
                    success: true,
                    product: {
                        sku: row.SKU || '',
                        code: row.Code || '',
                        name: row.name || row.nome || row.Name || row.Nome || 'Product Name',
                        description: row.description || row.descricao || row.Description || row.Descricao || 'Product Description'
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

    // Basic location search (adjust table/column names as needed)
    async function searchLocation(term){
        const q = String(term||'').trim();
        try{
            // Try common table/column names; adjust for your schema
            const { data, error } = await supabaseClient
                .from('Locations')
                .select('*')
                .ilike('code', `%${q}%`)
                .limit(50);
            if (error) return { success:false, error: error.message };
            return { success:true, locations: data||[] };
        } catch(e){ return { success:false, error: e.message }; }
    }

    // Search in Barcodes table for Product & Manual modes (sku/product/barcode), aligned with provided schema
    async function searchBarcodes(term){
        const q = String(term||'').trim();
        if (!q) return { success:true, items: [] };
        try {
            const pattern = `%${q}%`;
            // Columns per schema: sku text, product text, barcode text (lowercase)
            const { data, error } = await supabaseClient
                .from('Barcodes')
                .select('sku, product, barcode')
                .or(
                    `sku.ilike.${pattern},product.ilike.${pattern},barcode.ilike.${pattern}`
                )
                .limit(50);
            if (error) return { success:false, error: error.message };
            const items = Array.isArray(data) ? data : [];
            return { success:true, items };
        } catch(e){
            return { success:false, error: e.message };
        }
    }

    async function discoverTableStructure() {
        try {
            console.log('🔍 Discovering table structure...');
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

    window.supabaseSearch = {
        searchProduct,
        searchBySKU,
        searchBySKUAndCode,
        searchByCode,
        searchLocation,
    searchBarcodes,
        client: supabaseClient,
        discoverTableStructure
    };

    // Collections API (Supabase wrappers)
    function sc_isServerId(v){
        if (v == null) return false;
        const s = String(v);
        if (s.startsWith('ord_')) return false; // local temp id
        if (/^[0-9]+$/.test(s)) return true; // numeric
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return true; // uuid
        return false;
    }
    async function ca_listActive(){
        try{
            const { data, error } = await supabaseClient
                .from('collections_active')
                .select('*')
                .order('created_at', { ascending: false });
            if (error) return { success:false, error: error.message };
            return { success:true, data };
        } catch (e){ return { success:false, error: e.message }; }
    }

    async function ca_create(order){
        try{
            const payload = {
                customer: order.customer,
                reference: order.reference,
                cartons: order.cartons||0,
                pallets: order.pallets||0,
                tubes: order.tubes||0,
                contact_name: order.contactName,
                contact_number: order.contactNumber,
                email: order.email||null,
                collection_date: order.date
            };
            const { data, error } = await supabaseClient
                .from('collections_active')
                .insert([payload])
                .select()
                .single();
            if (error) return { success:false, error: error.message };
            return { success:true, data };
        } catch(e){ return { success:false, error: e.message }; }
    }

        async function ca_findExisting(order){
            try{
                // Try strict equality (works when collection_date is a DATE)
                let q = supabaseClient
                    .from('collections_active')
                    .select('*')
                    .eq('customer', order.customer)
                    .eq('reference', order.reference)
                    .eq('collection_date', order.date)
                    .limit(1);
                let { data, error } = await q;
                if (!error && Array.isArray(data) && data[0]){
                    return { success:true, data: data[0] };
                }
                // If not found (or type mismatch), try day-range (works when column is TIMESTAMP)
                const startIso = `${order.date}T00:00:00.000Z`;
                const endIso = `${order.date}T23:59:59.999Z`;
                const q2 = supabaseClient
                    .from('collections_active')
                    .select('*')
                    .eq('customer', order.customer)
                    .eq('reference', order.reference)
                    .gte('collection_date', startIso)
                    .lt('collection_date', endIso)
                    .limit(1);
                const { data: data2, error: error2 } = await q2;
                if (error2) return { success:false, error: error2.message };
                return { success:true, data: (Array.isArray(data2) && data2[0]) ? data2[0] : null };
            } catch(e){ return { success:false, error: e.message }; }
        }

    async function ca_update(id, patch){
        try{
            const payload = {};
            if ('customer' in patch) payload.customer = patch.customer;
            if ('reference' in patch) payload.reference = patch.reference;
            if ('cartons' in patch) payload.cartons = patch.cartons;
            if ('pallets' in patch) payload.pallets = patch.pallets;
            if ('tubes' in patch) payload.tubes = patch.tubes;
            if ('contactName' in patch) payload.contact_name = patch.contactName;
            if ('contactNumber' in patch) payload.contact_number = patch.contactNumber;
            if ('email' in patch) payload.email = patch.email;
            if ('date' in patch) payload.collection_date = patch.date;
            if (!sc_isServerId(id)){
                return { success:false, error:'Invalid server id for update' };
            }
                const { data, error } = await supabaseClient
                .from('collections_active')
                .update(payload)
                .eq('id', id) // works for uuid or numeric
                .select()
                .single();
            if (error) return { success:false, error: error.message };
            return { success:true, data };
        } catch(e){ return { success:false, error: e.message }; }
    }

    async function ca_delete(id){
        try{
            if (!sc_isServerId(id)) return { success:true, skipped:true };
            const { error } = await supabaseClient
                .from('collections_active')
                .delete()
                .eq('id', id);
            if (error) return { success:false, error: error.message };
            return { success:true };
        } catch(e){ return { success:false, error: e.message }; }
    }

        async function ch_confirm(id, collectedBy, operator, collectedAtISO, signatureData){
            try {
                if (!sc_isServerId(id)){
                    return { success:true, skipped:true }; // local-only id (ord_...)
                }
                // First, try RPC for atomic move
                const { data, error } = await supabaseClient.rpc('confirm_collection', {
                    p_id: id,
                    p_collected_by: collectedBy,
                    p_operator: operator,
                    p_collected_at: collectedAtISO,
                    p_signature_data: signatureData || null
                });
                if (!error) return { success:true, data, mode: 'rpc' };
                // Fallback: manual move if RPC is not available
                console.warn('RPC confirm_collection failed, using fallback:', error.message);
                // 1) Get the active row
                const { data: activeRow, error: selErr } = await supabaseClient
                    .from('collections_active')
                    .select('*')
                    .eq('id', id)
                    .single();
                if (selErr) return { success:false, error: selErr.message };
                // 2) Insert into history
                const historyPayload = {
                    customer: activeRow.customer,
                    reference: activeRow.reference,
                    cartons: activeRow.cartons,
                    pallets: activeRow.pallets,
                    tubes: activeRow.tubes,
                    contact_name: activeRow.contact_name,
                    contact_number: activeRow.contact_number,
                    email: activeRow.email,
                    collected_by: collectedBy,
                    operator: operator,
                    collected_at: collectedAtISO,
                    signature_data: signatureData || null
                };
                        // Avoid duplicate history rows: skip insert if same customer+reference+collected_at already exists
                        const { data: existsHist, error: existsErr } = await supabaseClient
                            .from('collections_history')
                            .select('id')
                            .eq('customer', activeRow.customer)
                            .eq('reference', activeRow.reference)
                            .eq('collected_at', collectedAtISO)
                            .limit(1);
                        if (existsErr) return { success:false, error: existsErr.message };
                        if (!Array.isArray(existsHist) || existsHist.length === 0){
                            const { error: insertErr } = await supabaseClient
                    .from('collections_history')
                    .insert([historyPayload]);
                            if (insertErr) return { success:false, error: insertErr.message };
                        }
                // 3) Delete from active
                const { error: deleteErr } = await supabaseClient
                    .from('collections_active')
                    .delete()
                    .eq('id', id);
                        if (deleteErr) return { success:false, error: deleteErr.message };
                        return { success:true, mode: 'fallback' };
            } catch(e){
                return { success:false, error: e.message };
            }
        }

        async function ch_listHistory(limit = 500){
            try {
                const { data, error } = await supabaseClient
                    .from('collections_history')
                    .select('*')
                    .order('collected_at', { ascending: false })
                    .limit(limit);
                if (error) return { success:false, error: error.message };
                return { success:true, data };
            } catch (e) {
                return { success:false, error: e.message };
            }
        }

    window.supabaseCollections = {
      async listActive(){
        const { data, error } = await supabase
          .from('collections_active')
                    .select('*')
          .order('collection_date', { ascending:false })
          .order('created_at', { ascending:false });
        return error ? { success:false, error } : { success:true, data };
      },
      async listHistory(limit = 500){
        const { data, error } = await supabase
          .from('collections_history')
          .select(`
                        id, customer, reference, cartons, pallets, tubes,
                        invoice, sales_rep,
            contact_name, contact_number, email,
            collected_by, operator, collected_at, collection_date,
            signature, signature_data, created_at
          `)
          .order('collected_at', { ascending:false })
          .limit(limit);
        return error ? { success:false, error } : { success:true, data };
      },
      async create(order){
        const payload = {
          customer: order.customer,
          reference: order.reference,
          cartons: order.cartons||0,
          pallets: order.pallets||0,
          tubes: order.tubes||0,
          contact_name: order.contactName,
          contact_number: order.contactNumber,
          email: order.email || null,
                    invoice: order.invoice || null,
                    sales_rep: order.salesRep || null,
          collection_date: order.date
        };
        const { data, error } = await supabase
          .from('collections_active')
          .insert(payload)
          .select()
          .single();
        return error ? { success:false, error } : { success:true, data };
      },
      async update(id, patch){
        const upd = {
          customer: patch.customer,
          reference: patch.reference,
          cartons: patch.cartons||0,
          pallets: patch.pallets||0,
          tubes: patch.tubes||0,
          contact_name: patch.contactName,
          contact_number: patch.contactNumber,
          email: patch.email || null,
                    invoice: patch.invoice || null,
                    sales_rep: patch.salesRep || null,
          collection_date: patch.date
        };
        const { data, error } = await supabase
          .from('collections_active')
          .update(upd)
          .eq('id', id)
          .select()
          .single();
        return error ? { success:false, error } : { success:true, data };
      },
      async remove(id){
        const { error } = await supabase
          .from('collections_active')
          .delete()
          .eq('id', id);
        return error ? { success:false, error } : { success:true };
      },
    async confirm(id, collectedBy, operator, isoDateTime, signatureDataUrl, invoice, salesRep){
        const { data, error } = await supabase
          .rpc('confirm_collection', {
            p_id: id,
            p_collected_by: collectedBy,
            p_operator: operator,
            p_collected_at: isoDateTime,
        p_signature: signatureDataUrl || null,
        p_invoice: invoice || null,
        p_sales_rep: salesRep || null
          });
        return error ? { success:false, error } : { success:true, data };
      }
    };

    // Garante objeto
window.supabaseCollections = window.supabaseCollections || {};

// === (RE)Definição listHistory simples + debug ===
window.supabaseCollections.listHistory = async function listHistory(limit = 500){
  const { data, error } = await supabase
    .from('collections_history')
    .select(`
      id, customer, reference, cartons, pallets, tubes,
    invoice, sales_rep,
      contact_name, contact_number, email,
      collected_by, operator, collected_at, collection_date,
      signature, signature_data, created_at
    `)
    .order('collected_at', { ascending:false })
    .limit(limit);

  if (error){
    console.warn('[listHistory] error', error);
    return { success:false, error };
  }
  console.log('[listHistory] fetched rows:', data?.length);
  return { success:true, data };
};

// Debug manual no console:
// supabaseCollections.listHistory().then(r=>console.log(r));

    // Reconcile local history (from localStorage) into DB (best-effort, skips duplicates)
    // reconcileLocalHistory removed (DB-only mode)

    return true;
  } catch (e) {
    console.error('Failed to initialize Supabase:', e);
    return false;
  }
})();

// (All other exports are set inside supabaseReady above)
