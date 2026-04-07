// Runs before every test file.
// Set env vars BEFORE any module that reads them at import time.
process.env.DB_PATH  = ':memory:'
process.env.SECRET   = 'test-secret-do-not-use-in-prod'
process.env.NODE_ENV = 'test'
