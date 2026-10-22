"""Version 1 flash ABI shared by the host compiler and Pypeline hardware."""
FLASH_BASE = 0x220000
MAGIC = 0x31305852  # b"RX01", little endian
WIDTH = 1920
HEIGHT = 1080
RUN_CAPACITY = 65536
PALETTE_OFFSET = 0x100
ROWS_OFFSET = 0x200
RUNS_OFFSET = 0x1000
