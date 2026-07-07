#!/bin/bash
# Run CourseVault in development mode
cd "$(dirname "$0")"

while true; do
    python3 app.py
    echo ""
    read -r -p "Run again? (Y/N): " choice
    [[ "$choice" != "Y" && "$choice" != "y" ]] && break
done
