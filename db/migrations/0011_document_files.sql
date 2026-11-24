-- The scan or photo of a rider document. The file itself lives outside the database (see UPLOAD_DIR); the row keeps where it is
-- and what it is. file_key is made by the server and is the only thing used to find the file. The older free-text file_ref is
-- just a note a person may type and is never used to read a file.
ALTER TABLE rider_documents
  ADD COLUMN file_key    text UNIQUE,
  ADD COLUMN file_name   text,
  ADD COLUMN file_type   text CHECK (file_type IN ('application/pdf', 'image/jpeg', 'image/png')),
  ADD COLUMN file_size   int  CHECK (file_size > 0),
  ADD COLUMN file_sha256 text,
  ADD CONSTRAINT file_columns_together CHECK ((file_key IS NULL) = (file_type IS NULL) AND (file_key IS NULL) = (file_size IS NULL) AND (file_key IS NULL) = (file_sha256 IS NULL));
