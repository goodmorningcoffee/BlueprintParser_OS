-- Text annotations: auto-detected patterns from OCR (phone, address, equipment tags, etc.)
ALTER TABLE pages ADD COLUMN text_annotations jsonb;
