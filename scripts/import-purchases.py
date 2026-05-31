#!/usr/bin/env python3
"""
Import POS inward report Excel files as purchase records.
Matches item names to existing materials in the database.
"""

import pandas as pd
import json
import sys

BASE_URL = "http://localhost:3001"

def parse_date(val):
    """Parse date from various formats to YYYY-MM-DD."""
    if pd.isna(val):
        return None
    s = str(val).strip()
    # Try DD/MM/YYYY format
    for fmt in ("%d/%m/%Y", "%Y-%m-%d", "%d %b %Y", "%d-%m-%Y"):
        try:
            from datetime import datetime
            return datetime.strptime(s.split(" ")[0], fmt).strftime("%Y-%m-%d")
        except:
            continue
    # Try pandas timestamp
    try:
        return pd.Timestamp(val).strftime("%Y-%m-%d")
    except:
        return None

def load_and_parse(filepath):
    """Load Excel file and parse purchase rows."""
    df = pd.read_excel(filepath, header=6)
    # Drop rows where ITEM NAME is empty
    df = df.dropna(subset=["ITEM NAME"])
    # Drop summary/total rows
    df = df[df["ITEM NAME"].astype(str).str.strip() != ""]

    rows = []
    for _, row in df.iterrows():
        item_name = str(row.get("ITEM NAME", "")).strip()
        if not item_name:
            continue

        qty = pd.to_numeric(row.get("INWARD QTY"), errors="coerce")
        if pd.isna(qty) or qty <= 0:
            continue

        # Use TOTAL INWARD AMOUNT / QTY as the effective unit price (includes GST)
        total_amount = pd.to_numeric(row.get("TOTAL INWARD AMOUNT"), errors="coerce")
        rate = pd.to_numeric(row.get("RATE"), errors="coerce")

        if pd.notna(total_amount) and total_amount > 0:
            unit_price = round(total_amount / qty, 2)
        elif pd.notna(rate) and rate > 0:
            unit_price = rate
        else:
            continue

        date = parse_date(row.get("INWARD DATE"))
        if not date:
            date = parse_date(row.get("CREATED DATE"))
        if not date:
            continue

        vendor = str(row.get("SUPPLIER NAME", "")).strip()
        invoice = str(row.get("INVOICE ID", "")).strip()
        if invoice == "nan":
            invoice = ""

        rows.append({
            "item_name": item_name.upper(),
            "vendor": vendor if vendor != "nan" else "",
            "quantity": float(qty),
            "unit_price": float(unit_price),
            "date": date,
            "invoice": invoice,
        })

    return rows

def main():
    import urllib.request

    files = [
        "/Users/shashankreddy/Downloads/inward report detail (1).xlsx",
        "/Users/shashankreddy/Downloads/inward report detail.xlsx",
    ]

    # 1. Load existing materials from API
    print("Fetching existing materials from inventory...")
    req = urllib.request.Request(f"{BASE_URL}/api/inventory")
    with urllib.request.urlopen(req) as resp:
        data = json.loads(resp.read().decode())

    materials = data.get("materials", [])
    print(f"Found {len(materials)} materials in inventory")

    # Build lookup: name -> id (case-insensitive)
    name_to_id = {}
    for m in materials:
        name_to_id[m["name"].strip().upper()] = m["id"]

    # 2. Parse both Excel files
    all_purchases = []
    for f in files:
        print(f"Parsing {f}...")
        rows = load_and_parse(f)
        print(f"  -> {len(rows)} valid purchase rows")
        all_purchases.extend(rows)

    print(f"\nTotal purchase rows: {len(all_purchases)}")

    # 3. Match to materials and prepare API calls
    matched = []
    unmatched_names = set()

    for p in all_purchases:
        material_id = name_to_id.get(p["item_name"])
        if material_id:
            matched.append({
                "material_id": material_id,
                "vendor": p["vendor"],
                "brand": "",
                "quantity": p["quantity"],
                "unit_price": p["unit_price"],
                "date": p["date"],
                "notes": f"Invoice #{p['invoice']}" if p["invoice"] else "POS Inward Import",
            })
        else:
            unmatched_names.add(p["item_name"])

    print(f"Matched: {len(matched)} purchases")
    print(f"Unmatched items: {len(unmatched_names)}")

    if unmatched_names:
        print("\nUnmatched item names (first 20):")
        for name in sorted(unmatched_names)[:20]:
            print(f"  - {name}")

    if not matched:
        print("No purchases to import!")
        return

    # 4. Submit in batches to avoid timeout
    BATCH_SIZE = 100
    total_imported = 0
    total_failed = 0

    print(f"\nImporting {len(matched)} purchases in batches of {BATCH_SIZE}...")

    for i in range(0, len(matched), BATCH_SIZE):
        batch = matched[i:i + BATCH_SIZE]
        batch_num = (i // BATCH_SIZE) + 1
        total_batches = (len(matched) + BATCH_SIZE - 1) // BATCH_SIZE

        success_count = 0
        fail_count = 0

        for purchase in batch:
            try:
                payload = json.dumps(purchase).encode("utf-8")
                req = urllib.request.Request(
                    f"{BASE_URL}/api/purchases",
                    data=payload,
                    headers={"Content-Type": "application/json"},
                    method="POST",
                )
                with urllib.request.urlopen(req) as resp:
                    resp.read()
                success_count += 1
            except Exception as e:
                fail_count += 1

        total_imported += success_count
        total_failed += fail_count
        print(f"  Batch {batch_num}/{total_batches}: {success_count} OK, {fail_count} failed")

    print(f"\n=== IMPORT COMPLETE ===")
    print(f"Total imported: {total_imported}")
    print(f"Total failed: {total_failed}")
    print(f"Unmatched items: {len(unmatched_names)}")

if __name__ == "__main__":
    main()
