import React from 'react';
import * as XLSX from 'xlsx';
import { Product, ProductCat } from '../../types';
import { StorageService, formatBaht } from '../../mockData';
import * as api from '../../api';
import { notify, ask, askText } from '../Dialog';
import type { AdminPanelCore } from './useAdminPanel';


// F&B and equipment catalog: create, stock, deposit, Excel import.
export function useProductActions(deps: AdminPanelCore) {
  const {
    newProductCat,
    newProductDeposit,
    newProductIsRental,
    newProductName,
    newProductPrice,
    newProductStock,
    onAddAuditLog,
    onRefreshAll,
    products,
    setNewProductName,
    setNewProductPrice,
    setNewProductStock,
    setProducts,
    stockVariantSel
  } = deps;
  // Product Inventory management
  const handleCreateProduct = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newProductName || !newProductPrice) return;

    if (api.USE_BACKEND) {
      return api.createProducts([{ name: newProductName, category: newProductCat, price: Number(newProductPrice), isRental: newProductCat === ProductCat.EQUIPMENT && newProductIsRental,
        deposit: newProductCat === ProductCat.EQUIPMENT && newProductIsRental ? Number(newProductDeposit) || 0 : 0, stock: Number(newProductStock) }])
        .then(() => {
          setNewProductName('');
          setNewProductPrice(20);
          setNewProductStock(50);
          onRefreshAll();
          notify('บันทึกเพิ่มสินค้า/บริการสำเร็จ!');
        })
        .catch(err => notify(`เพิ่มสินค้าไม่สำเร็จ: ${err.message}`));
    }

    const newProdId = 'pd-' + Date.now();
    const newProd: Product = {
      id: newProdId,
      name: newProductName,
      category: newProductCat,
      price: Number(newProductPrice),
      isRental: newProductCat === ProductCat.EQUIPMENT && newProductIsRental,
      deposit: newProductCat === ProductCat.EQUIPMENT && newProductIsRental ? Number(newProductDeposit) || 0 : 0,
      stock: Number(newProductStock),
      isActive: true
    };

    const currentProds = StorageService.get<Product[]>('products', []);
    const updated = [...currentProds, newProd];

    StorageService.set('products', updated);
    setProducts(updated);

    onAddAuditLog('PRODUCT_CREATED_BY_ADMIN', 'Product', newProdId, null, newProd);

    // reset
    setNewProductName('');
    setNewProductPrice(20);
    setNewProductStock(50);
    onRefreshAll();
    notify('บันทึกเพิ่มสินค้า/บริการสำเร็จ!');
  };

  // Restock (+) or count correction (-), with a reason for the audit log.
  // Shoes are stocked per size: the size picked next to the buttons.
  // Rental deposit per unit (cash, given back on return).
  const handleSetDeposit = async (p: Product) => {
    const raw = await askText(`มัดจำต่อชิ้นของ "${p.name}" (บาท, 0 = ไม่เก็บมัดจำ)\nพนักงานเก็บเป็นเงินสดตอนเช่า และคืนให้ตอนคืนของ`,
      { title: 'ตั้งมัดจำ', defaultValue: String(p.deposit ?? 0), required: true, okLabel: 'บันทึก' });
    if (raw === null) return;
    const deposit = Number(raw.trim());
    if (!Number.isFinite(deposit) || deposit < 0 || deposit > 100000) {
      notify('มัดจำต้องเป็นตัวเลข 0 - 100,000 บาท');
      return;
    }
    const done = () => {
      onAddAuditLog('PRODUCT_UPDATED', 'Product', p.id, { deposit: p.deposit ?? 0 }, { deposit });
      onRefreshAll();
      notify(`ตั้งมัดจำ "${p.name}" เป็น ${formatBaht(deposit)} บาทแล้ว`);
    };
    if (api.USE_BACKEND) {
      return api.updateProduct(p, { deposit }).then(done).catch(err => notify(`บันทึกไม่สำเร็จ: ${err.message}`));
    }
    const updated = StorageService.get<Product[]>('products', []).map(x => x.id === p.id ? { ...x, deposit } : x);
    StorageService.set('products', updated);
    setProducts(updated);
    done();
  };

  const handleUpdateStockValue = async (prodId: string, val: number) => {
    const prod = products.find(p => p.id === prodId);
    if (!prod) return;
    const variant = prod.variants?.find(v => v.id === stockVariantSel[prodId]);
    if (prod.variants?.length && !variant) {
      notify('เลือกเบอร์ที่จะปรับสต๊อกก่อน');
      return;
    }
    const what = variant ? `${prod.name} เบอร์ ${variant.label}${variant.gender ? ` (${variant.gender})` : ''}` : prod.name;
    const reason = await askText(`เหตุผลการ${val > 0 ? 'เพิ่ม' : 'ลด'}สต๊อก ${what} ${val > 0 ? '+' : ''}${val} ชิ้น:`, { title: 'ปรับสต๊อก', defaultValue: val > 0 ? 'รับสินค้าเข้า' : 'ปรับยอดตามนับจริง' });
    if (!reason) return;

    if (api.USE_BACKEND) {
      return api.adjustStock(prodId, val, reason, variant?.id)
        .then(updated => setProducts(list => list.map(p => p.id === prodId ? updated : p)))
        .catch(err => notify(`ปรับสต๊อกไม่สำเร็จ: ${err.message}`));
    }

    const currentProds = StorageService.get<Product[]>('products', []);
    const updated = currentProds.map(p => {
      if (p.id !== prodId) return p;
      if (variant) {
        const variants = p.variants?.map(v => v.id === variant.id ? { ...v, stock: Math.max(0, v.stock + val) } : v);
        const afterStock = (variants || []).reduce((n, v) => n + v.stock, 0);
        onAddAuditLog('PRODUCT_STOCK_ADJUSTED', 'Product', prodId, { stock: p.stock, variant: variant.id, variantStock: variant.stock }, { stock: afterStock, reason });
        return { ...p, variants, stock: afterStock };
      }
      const afterStock = Math.max(0, p.stock + val);
      onAddAuditLog('PRODUCT_STOCK_ADJUSTED', 'Product', prodId, { stock: p.stock }, { stock: afterStock, reason });
      return { ...p, stock: afterStock };
    });

    StorageService.set('products', updated);
    setProducts(updated);
    onRefreshAll();
  };

  const handleDownloadTemplate = () => {
    const wsData = [
      {
        "ชื่อสินค้า": "ลูกแบดมินตัน RSL Silver",
        "ราคา": 80,
        "สต็อก": 200,
        "หมวดหมู่": "EQUIPMENT",
        "เช่า": "FALSE",
        "หมวดย่อย": ""
      },
      {
        "ชื่อสินค้า": "รองเท้ากีฬาแกรนสปอร์ต ชาย/หญิง",
        "ราคา": 50,
        "สต็อก": 25,
        "หมวดหมู่": "EQUIPMENT",
        "เช่า": "TRUE",
        "หมวดย่อย": "shoes"
      },
      {
        "ชื่อสินค้า": "ข้าวกะเพราหมูสับไข่ดาว",
        "ราคา": 65,
        "สต็อก": 40,
        "หมวดหมู่": "FB",
        "เช่า": "FALSE",
        "หมวดย่อย": ""
      },
      {
        "ชื่อสินค้า": "น้ำดื่มแร่สิงห์ 600ml",
        "ราคา": 15,
        "สต็อก": 150,
        "หมวดหมู่": "FB",
        "เช่า": "FALSE",
        "หมวดย่อย": ""
      }
    ];

    const ws = XLSX.utils.json_to_sheet(wsData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "รายชื่ออาหารและเครื่องกีฬา");
    XLSX.writeFile(wb, "product_upload_template.xlsx");
  };

  const handleExcelUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Cleared so the same file can be picked again after fixing an error.
    e.target.value = '';
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (evt) => {
      try {
        const wb = XLSX.read(evt.target?.result as ArrayBuffer, { type: 'array' });
        const wsname = wb.SheetNames[0];
        const ws = wb.Sheets[wsname];
        const data = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws);

        if (data.length === 0) {
          notify('ไม่พบข้อมูลรายการสินค้าในสเปรดชีต Excel นี้');
          return;
        }

        const currentProds = StorageService.get<Product[]>('products', []);
        let importedCount = 0;
        const newProds: Product[] = [...currentProds];
        const apiRows: api.ProductInput[] = [];
        // A product already in the catalog (or twice in the file) is skipped,
        // so importing a corrected copy doesn't duplicate everything.
        const knownNames = new Set((api.USE_BACKEND ? products : currentProds).map(p => p.name.trim().toLowerCase()));
        const skipped: string[] = [];

        data.forEach(row => {
          // The first column that has a value - a 0 price or 0 stock is a
          // value, not a missing cell.
          const pick = (...keys: string[]) => {
            for (const k of keys) if (row[k] !== undefined && row[k] !== null && row[k] !== '') return row[k];
            return undefined;
          };
          const name = pick('ชื่อสินค้า', 'name', 'Name');
          const priceVal = pick('ราคา', 'price', 'Price');
          const stockVal = pick('จำนวนสินค้า', 'สต็อก', 'stock', 'Stock');
          const categoryVal = pick('หมวดหมู่', 'category', 'Category');
          const isRentalVal = pick('เช่า', 'isRental', 'IsRental', 'เช่าเล่น') ?? false;
          const subCategoryVal = pick('หมวดย่อย', 'subCategory', 'SubCategory');
          const depositVal = Number(pick('มัดจำ', 'deposit', 'Deposit') ?? 0);

          const cleanName = String(name ?? '').trim();
          const price = Number(priceVal);
          const stock = stockVal === undefined ? 50 : Number(stockVal);
          // The server's limits, so browser-only mode accepts the same rows.
          if (!cleanName || cleanName.length > 200 || priceVal === undefined || !Number.isFinite(price) || price < 0 || price > 100000 ||
              !Number.isInteger(stock) || stock < 0 || stock > 100000) {
            if (cleanName) skipped.push(`${cleanName} (ข้อมูลไม่ถูกต้อง)`);
            return;
          }
          if (knownNames.has(cleanName.toLowerCase())) {
            skipped.push(`${cleanName} (มีอยู่แล้ว)`);
            return;
          }
          knownNames.add(cleanName.toLowerCase());

          const category = String(categoryVal).toUpperCase() === 'EQUIPMENT' || String(categoryVal).includes('อุปกรณ์') || String(categoryVal).includes('เช่า')
            ? ProductCat.EQUIPMENT
            : ProductCat.FB;

          // The template's เช่า column decides; F&B is never rented.
          const isRental = category === ProductCat.EQUIPMENT && (isRentalVal === true || String(isRentalVal).toLowerCase() === 'true');

          const deposit = isRental && Number.isFinite(depositVal) && depositVal > 0 && depositVal <= 100000 ? depositVal : 0;
          apiRows.push({
            name: cleanName, category, price, isRental, deposit, stock, subCategory: subCategoryVal ? String(subCategoryVal) : undefined
          });
          const pId = 'pd-excel-' + Math.random().toString(36).slice(2, 11);
          newProds.push({
            id: pId,
            name: cleanName,
            category: category,
            price,
            stock,
            isRental: isRental,
            deposit,
            isActive: true,
            subCategory: subCategoryVal ? String(subCategoryVal) : undefined
          });
          importedCount++;
        });

        const skippedNote = skipped.length ? `\n\nข้าม ${skipped.length} รายการ:\n${skipped.slice(0, 15).join('\n')}${skipped.length > 15 ? '\n…' : ''}` : '';
        // Preview: nothing is saved until the admin has seen what was read.
        if (importedCount > 0) {
          const lines = apiRows.slice(0, 20).map(r =>
            `• ${r.name} — ${r.category === ProductCat.EQUIPMENT ? (r.isRental ? `อุปกรณ์ให้เช่า${r.deposit ? ` (มัดจำ ${formatBaht(r.deposit)})` : ''}` : 'อุปกรณ์') : 'อาหาร/เครื่องดื่ม'} · ${formatBaht(r.price)} บาท · สต๊อก ${r.stock}`);
          const more = apiRows.length > 20 ? `\n… และอีก ${apiRows.length - 20} รายการ` : '';
          if (!(await ask(`จะนำเข้าสินค้าใหม่ ${importedCount} รายการ:\n${lines.join('\n')}${more}${skippedNote}`,
            { title: 'ตรวจรายการก่อนนำเข้า', okLabel: `นำเข้า ${importedCount} รายการ` }))) return;
        }
        if (importedCount > 0 && api.USE_BACKEND) {
          api.createProducts(apiRows)
            .then(list => {
              onRefreshAll();
              notify(`นำเข้าสินค้า ${list.length} รายการเรียบร้อย${skippedNote}`);
            })
            .catch(err => notify(`นำเข้าไม่สำเร็จ (ไม่มีรายการใดถูกบันทึก): ${err.message}`));
        } else if (importedCount > 0) {
          // Re-read: stock may have changed (e.g. a sale in another tab)
          // while the preview was open; only the new rows are added.
          const saved = [...StorageService.get<Product[]>('products', []), ...newProds.slice(currentProds.length)];
          StorageService.set('products', saved);
          setProducts(saved);
          onAddAuditLog('PRODUCTS_UPLOADED_VIA_EXCEL', 'Product', 'bulk', null, { count: importedCount });
          onRefreshAll();
          notify(`อัปโหลดเสร็จสมบูรณ์! นำเข้าสินค้าแถวใหม่ ${importedCount} รายการเข้าสู่ตู้อัตโนมัติและคลังสต๊อกสำเร็จค่ะ 🚀${skippedNote}`);
        } else {
          notify(`ไม่มีสินค้าใหม่ให้นำเข้า (หัวคอลัมน์ต้องตรงกับไฟล์ตัวอย่างด้านบน)${skippedNote}`);
        }
      } catch (err) {
        notify('เกิดข้อผิดพลาดขณะแกะไฟล์สเปรดชีต Excel: ' + (err instanceof Error ? err.message : String(err)));
      }
    };
    reader.readAsArrayBuffer(file);
  };
  return {
    handleCreateProduct,
    handleSetDeposit,
    handleUpdateStockValue,
    handleDownloadTemplate,
    handleExcelUpload
  };
}
