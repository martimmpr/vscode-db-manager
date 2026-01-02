# Change Log

## [1.1.0] - 02-01-2026

### Added
- Added New Interface for Connection Management
- Added New Interface for Table Creation/Editing

### Fixed
- Fixed Table Name not Updating after Rename
- Fixed New Interface Bugs:
  - Auto-reload TableViewer after column operations (add/edit/delete)
  - Added optional default value field in add/edit column forms
  - Fixed UNIQUE and PRIMARY KEY constraints loading in edit column form
  - Implemented full constraint support (NOT NULL, UNIQUE, PRIMARY KEY, AUTO_INCREMENT/IDENTITY) in both MySQL and PostgreSQL adapters
  - Changed from DROP/ADD to MODIFY approach to preserve data when editing columns
  - Fixed duplicate column addition bug (was adding column twice)
  - Added success notification when column is added
  - Removed preventive duplicate column validation that caused false positives

## [1.0.1] - 27-12-2025

### Fixed
- Corrected extension naming consistency

## [1.0.0] - 26-12-2025

### Added
- Multiple database connections with automatic database type detection (PostgreSQL, MySQL, MariaDB)
- Database explorer with tree view for browsing databases and tables
- Table viewer with full CRUD operations (view, edit, insert, delete) and pagination
- SQL query runner with `Ctrl+Enter` keyboard shortcut
- Query results viewer with syntax highlighting and field type information
- Export options: CSV/SQL export for query results and full database exports
- Integrated terminal: Open native database CLI (psql, mysql, mariadb) directly in VS Code
- Real-time refresh for connections and databases
- Search and filter capabilities for databases, tables and table data
- Modern UI with support for light and dark themes
- Column management: Add, remove, and reorder columns (reordering PostgreSQL only)
- Visual indicators for primary keys, unique constraints, and auto-increment fields
- Connection management: Add, edit, and remove database connections
- Sorting capabilities in table viewer