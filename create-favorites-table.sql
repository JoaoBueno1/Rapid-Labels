-- SQL to create favorites table in Supabase
-- Execute this in the Supabase Dashboard SQL Editor

-- Create user_favorites table
CREATE TABLE IF NOT EXISTS user_favorites (
  id SERIAL PRIMARY KEY,
  sku VARCHAR(255) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(sku)
);

-- Add index for better performance
CREATE INDEX IF NOT EXISTS idx_user_favorites_sku ON user_favorites(sku);

-- Add comments for documentation
COMMENT ON TABLE user_favorites IS 'Stores global user favorites for restock products (identified by SKU)';
COMMENT ON COLUMN user_favorites.sku IS 'Product SKU that is marked as favorite';
COMMENT ON COLUMN user_favorites.created_at IS 'When the favorite was first added';
COMMENT ON COLUMN user_favorites.updated_at IS 'When the favorite was last updated';

-- Enable Row Level Security (RLS)
ALTER TABLE user_favorites ENABLE ROW LEVEL SECURITY;

-- Create policy to allow public access (since there's no user authentication)
-- This allows any user to read/write favorites
CREATE POLICY "Allow public access to favorites" ON user_favorites
FOR ALL USING (true)
WITH CHECK (true);

-- Optional: View current favorites
-- SELECT * FROM user_favorites ORDER BY created_at DESC;