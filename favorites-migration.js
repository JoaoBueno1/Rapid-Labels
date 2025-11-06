// Favorites Migration Script
// Purpose: Create favorites table and migrate localStorage favorites to Supabase

window.favoritesMigration = {
  // Create favorites table if it doesn't exist
  async createFavoritesTable() {
    try {
      await window.supabaseReady;
      
      // Try to create the table (this will fail if it already exists, which is fine)
      const createTableSQL = `
        CREATE TABLE IF NOT EXISTS user_favorites (
          id SERIAL PRIMARY KEY,
          sku VARCHAR(255) NOT NULL,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(sku)
        );
      `;
      
      // Note: This would require RPC call or direct SQL execution
      // For now, we'll test if the table exists by trying to query it
      const { data, error } = await window.supabase
        .from('user_favorites')
        .select('sku')
        .limit(1);
        
      if (error && error.code === 'PGRST116') {
        console.log('❌ Favorites table does not exist. Please create it manually in Supabase dashboard.');
        console.log('SQL to create table:');
        console.log(createTableSQL);
        return false;
      }
      
      console.log('✅ Favorites table exists and is accessible');
      return true;
    } catch (error) {
      console.error('❌ Error checking/creating favorites table:', error);
      return false;
    }
  },

  // Load favorites from database
  async loadFavoritesFromDB() {
    try {
      await window.supabaseReady;
      
      const { data, error } = await window.supabase
        .from('user_favorites')
        .select('sku');
        
      if (error) {
        console.error('❌ Error loading favorites from database:', error);
        return new Set();
      }
      
      const favorites = new Set();
      if (data) {
        data.forEach(row => favorites.add(String(row.sku)));
      }
      
      console.log(`✅ Loaded ${favorites.size} favorites from database`);
      return favorites;
    } catch (error) {
      console.error('❌ Error loading favorites:', error);
      return new Set();
    }
  },

  // Save favorite to database
  async addFavoriteToDB(sku) {
    try {
      await window.supabaseReady;
      
      const { error } = await window.supabase
        .from('user_favorites')
        .upsert(
          { sku: String(sku) },
          { onConflict: 'sku' }
        );
        
      if (error) {
        console.error('❌ Error adding favorite to database:', error);
        return false;
      }
      
      console.log(`✅ Added favorite ${sku} to database`);
      return true;
    } catch (error) {
      console.error('❌ Error adding favorite:', error);
      return false;
    }
  },

  // Remove favorite from database
  async removeFavoriteFromDB(sku) {
    try {
      await window.supabaseReady;
      
      const { error } = await window.supabase
        .from('user_favorites')
        .delete()
        .eq('sku', String(sku));
        
      if (error) {
        console.error('❌ Error removing favorite from database:', error);
        return false;
      }
      
      console.log(`✅ Removed favorite ${sku} from database`);
      return true;
    } catch (error) {
      console.error('❌ Error removing favorite:', error);
      return false;
    }
  },

  // Migrate localStorage favorites to database
  async migrateLocalStorageToDB() {
    try {
      // Load current localStorage favorites
      const FAVORITES_KEY = 'restock_favorites_skus';
      const localFavorites = new Set();
      
      try {
        const raw = localStorage.getItem(FAVORITES_KEY);
        if (raw) {
          JSON.parse(raw).forEach(sku => localFavorites.add(String(sku)));
        }
      } catch (error) {
        console.error('❌ Error reading localStorage favorites:', error);
      }
      
      if (localFavorites.size === 0) {
        console.log('ℹ️ No localStorage favorites to migrate');
        return true;
      }
      
      console.log(`🔄 Migrating ${localFavorites.size} favorites from localStorage to database...`);
      
      // Add each favorite to database
      let migrated = 0;
      for (const sku of localFavorites) {
        const success = await this.addFavoriteToDB(sku);
        if (success) migrated++;
      }
      
      console.log(`✅ Successfully migrated ${migrated}/${localFavorites.size} favorites to database`);
      
      // Optional: Clear localStorage after successful migration
      // localStorage.removeItem(FAVORITES_KEY);
      
      return true;
    } catch (error) {
      console.error('❌ Error during migration:', error);
      return false;
    }
  },

  // Full migration process
  async runMigration() {
    console.log('🚀 Starting favorites migration...');
    
    const tableExists = await this.createFavoritesTable();
    if (!tableExists) {
      console.log('❌ Migration failed: favorites table not available');
      return false;
    }
    
    const migrationSuccess = await this.migrateLocalStorageToDB();
    if (!migrationSuccess) {
      console.log('❌ Migration failed during localStorage transfer');
      return false;
    }
    
    console.log('✅ Favorites migration completed successfully!');
    return true;
  }
};

console.log('Favorites migration script loaded. Use window.favoritesMigration.runMigration() to start.');