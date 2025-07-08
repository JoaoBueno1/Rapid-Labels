// Node.js script to test Supabase connection and discover table structure
// Run this with: node discover-supabase.js

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://iaqnxamnjftwqdbsnfyl.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlhcW54YW1uamZ0d3FkYnNuZnlsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTE5NTc5MzQsImV4cCI6MjA2NzUzMzkzNH0.k3G4Tc6U7XdYGmU9wTkcg3R1cLRij-CN6EbjSSbd9bE';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

async function testConnection() {
    console.log('🚀 Testing Supabase connection...');
    
    try {
        // Test basic connection
        const { data, error } = await supabase
            .from('Products')
            .select('*')
            .limit(1);

        if (error) {
            console.log('❌ Connection error:', error.message);
            console.log('Error details:', JSON.stringify(error, null, 2));
            return false;
        } else {
            console.log('✅ Connection successful!');
            if (data && data.length > 0) {
                console.log('📊 Table "Products" exists and has data');
                return true;
            } else {
                console.log('⚠️ Table "Products" exists but is empty');
                return true;
            }
        }
    } catch (error) {
        console.log('❌ Unexpected error:', error.message);
        return false;
    }
}

async function discoverColumns() {
    console.log('🔍 Discovering columns in "Products" table...');
    
    try {
        // Get one record to see column structure
        const { data, error } = await supabase
            .from('Products')
            .select('*')
            .limit(1);

        if (error) {
            console.log('❌ Error:', error.message);
            return null;
        }

        if (!data || data.length === 0) {
            console.log('⚠️ Table exists but has no data');
            return null;
        }

        console.log('✅ Found table structure!');
        console.log('📋 Column names:');
        
        const columns = Object.keys(data[0]);
        columns.forEach((col, index) => {
            console.log(`  ${index + 1}. "${col}"`);
        });

        console.log('\n📝 Sample values:');
        Object.entries(data[0]).forEach(([key, value]) => {
            const displayValue = typeof value === 'string' && value.length > 50 
                ? value.substring(0, 50) + '...' 
                : JSON.stringify(value);
            console.log(`  ${key}: ${displayValue}`);
        });

        // Look for likely SKU/CODE columns
        console.log('\n🎯 Analyzing for SKU/CODE-like columns:');
        const possibleSKU = columns.filter(col => 
            col.toLowerCase().includes('sku') || 
            col.toLowerCase().includes('code') || 
            col.toLowerCase().includes('id') ||
            col.toLowerCase().includes('ref') ||
            col.toLowerCase().includes('num')
        );
        
        if (possibleSKU.length > 0) {
            console.log('🎯 Possible SKU/CODE columns found:');
            possibleSKU.forEach(col => {
                console.log(`  - "${col}" = ${JSON.stringify(data[0][col])}`);
            });
        } else {
            console.log('⚠️ No obvious SKU/CODE columns found');
        }

        return { columns, sample: data[0], possibleSKU };

    } catch (error) {
        console.log('❌ Unexpected error:', error.message);
        return null;
    }
}

async function getSampleData() {
    console.log('📦 Getting 3 sample records from Products table...');
    
    try {
        const { data, error } = await supabase
            .from('Products')
            .select('*')
            .limit(3);

        if (error) {
            console.log('❌ Error:', error.message);
            return null;
        }

        if (!data || data.length === 0) {
            console.log('⚠️ No data found in table');
            return null;
        }

        console.log(`✅ Found ${data.length} records:`);
        
        data.forEach((record, index) => {
            console.log(`\n📄 Record ${index + 1}:`);
            Object.entries(record).forEach(([key, value]) => {
                const displayValue = typeof value === 'string' && value.length > 100 
                    ? value.substring(0, 100) + '...' 
                    : JSON.stringify(value);
                console.log(`  ${key}: ${displayValue}`);
            });
        });

        return data;

    } catch (error) {
        console.log('❌ Unexpected error:', error.message);
        return null;
    }
}

async function main() {
    console.log('🚀 Starting Supabase discovery...\n');
    
    const connectionOk = await testConnection();
    if (!connectionOk) {
        console.log('❌ Connection failed, stopping.');
        return;
    }
    
    console.log('\n' + '='.repeat(50) + '\n');
    
    const structure = await discoverColumns();
    if (!structure) {
        console.log('❌ Could not discover table structure.');
        return;
    }
    
    console.log('\n' + '='.repeat(50) + '\n');
    
    await getSampleData();
    
    console.log('\n' + '='.repeat(50) + '\n');
    console.log('🎯 DISCOVERY COMPLETE!');
    console.log('Use the column names found above to update your search functions.');
}

if (require.main === module) {
    main().catch(console.error);
}

module.exports = {
    testConnection,
    discoverColumns,
    getSampleData
};
