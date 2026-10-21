// The Go backend answers errors in English (they're also its log and API
// contract); every screen shows them in Thai. api.ts runs each server
// message through thaiErrorText once, so customer, staff and admin screens
// all get the same wording. Rules are tried in order - specific before
// general - and a message no rule knows is shown as sent.

type Rule = [RegExp, string | ((m: RegExpMatchArray) => string)];

const baht = (s: string) => Number(s).toLocaleString('en-US', { maximumFractionDigits: 2 });

// Drops the sentinel in front of a detail ("slot already booked: <court>
// ..."). Only known sentinels: court and product names may contain ": "
// themselves (e.g. "สนามบาสเกตบอล B (ครึ่งสนาม: ซ้าย)").
const SENTINEL = /^(?:slot already booked|out of stock|invalid booking request|invalid state for this action|not found): /i;
const detail = (s: string) => s.replace(SENTINEL, '');

const RULES: Rule[] = [
  // A bulk import names the failing row; translate the rest after it.
  [/^row (\d+): (.*)$/i, m => `แถวที่ ${m[1]}: ${thaiErrorText(m[2])}`],
  // Sign-in and accounts
  [/invalid login credentials/i, 'เบอร์โทร/อีเมล หรือรหัสผ่านไม่ถูกต้อง'],
  [/too many failed logins - try again in (\d+) minutes/i, m => `ลองผิดหลายครั้งเกินไป กรุณารอ ${m[1]} นาทีแล้วลองใหม่`],
  [/already registered/i, 'เบอร์โทรหรืออีเมลนี้สมัครไว้แล้ว — เข้าสู่ระบบ หรือกด "ลืมรหัสผ่าน"'],
  [/at least 9 digits|phone number is too long/i, 'เบอร์โทรไม่ถูกต้อง (ใส่เบอร์มือถือ 10 หลัก เช่น 0812345678)'],
  [/account is suspended/i, 'บัญชีนี้ถูกระงับ กรุณาติดต่อพนักงาน'],
  [/email address is not valid/i, 'อีเมลไม่ถูกต้อง (เว้นว่างได้ถ้าไม่มี)'],
  [/password must be at least 6/i, 'รหัสผ่านต้องมีอย่างน้อย 6 ตัว'],
  [/password must be at most 72/i, 'รหัสผ่านยาวเกินไป (ไม่เกิน 72 ตัว)'],
  [/invalid or expired token|session expired/i, 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่'],
  [/^login required/i, 'กรุณาเข้าสู่ระบบก่อน'],
  [/your role is not allowed/i, 'บัญชีนี้ไม่มีสิทธิ์ทำรายการนี้'],
  [/could not check your session right now/i, 'ตรวจสอบการเข้าสู่ระบบไม่ได้ชั่วคราว กรุณาลองใหม่'],
  [/internal server error/i, 'เซิร์ฟเวอร์ขัดข้อง กรุณาลองใหม่อีกครั้ง'],
  [/too many sign-ups from this network/i, 'สมัครสมาชิกจากเครือข่ายนี้บ่อยเกินไป กรุณาลองใหม่ภายหลัง'],
  [/points change must be between/i, 'ปรับแต้มได้ครั้งละไม่เกิน ±10,000 แต้ม'],
  [/you cannot change your own points/i, 'ปรับแต้มของตัวเองไม่ได้'],
  [/you cannot change your own role or status/i, 'เปลี่ยนสิทธิ์หรือระงับบัญชีของตัวเองไม่ได้'],
  [/membership tiers only apply to customers/i, 'ระดับสมาชิกใช้กับบัญชีลูกค้าเท่านั้น'],
  [/only customers have loyalty points/i, 'แต้มสะสมมีเฉพาะบัญชีลูกค้า'],

  // Booking
  [/you already have (\d+) bookings awaiting payment/i, m => `คุณมีการจองที่รอชำระ/รอตรวจสลิปอยู่ ${m[1]} รายการแล้ว กรุณารอให้ยืนยันก่อนจองเพิ่ม`],
  [/too many unpaid bookings/i, 'มีการจองที่รอชำระครบจำนวนแล้ว กรุณารอให้ยืนยันก่อนจองเพิ่ม'],
  [/(.+?) (\d\d:\d\d)-(\d\d:\d\d) is already reserved/i, m => `${detail(m[1])} ${m[2]}-${m[3]} ถูกจองไปแล้ว กรุณาเลือกเวลาอื่น`],
  [/slot already booked/i, 'ช่วงเวลานี้เพิ่งถูกจองไป กรุณาเลือกเวลาอื่น'],
  [/has already started - book it at the counter/i, 'ช่วงเวลานี้เริ่มไปแล้ว จองออนไลน์ไม่ได้ (ติดต่อเคาน์เตอร์ได้)'],
  [/has already passed|is over\)/i, 'ช่วงเวลานี้ผ่านไปแล้ว'],
  [/can only be booked during off-peak hours/i, 'สนามนี้จองได้เฉพาะช่วง Off-Peak'],
  [/is closed at|currently closed for booking/i, 'สนามปิดบริการในช่วงเวลานี้ กรุณาเลือกเวลาหรือสนามอื่น'],
  [/outside opening hours|no price set for that hour/i, 'ช่วงเวลานี้อยู่นอกเวลาเปิดให้บริการ'],
  [/online bookings open (\d+) days ahead/i, m => `จองออนไลน์ล่วงหน้าได้ไม่เกิน ${m[1]} วัน`],
  [/at most (\d+) slots per booking/i, m => `จองได้สูงสุด ${m[1]} ชั่วโมงต่อครั้ง`],
  [/requested twice/i, 'เลือกช่วงเวลาเดียวกันซ้ำ'],
  [/select at least one slot/i, 'กรุณาเลือกช่วงเวลาอย่างน้อย 1 ชั่วโมง'],
  [/start_time must be on the hour/i, 'เวลาเริ่มต้องเป็นต้นชั่วโมง (เช่น 09:00)'],
  [/court .* does not exist|court .* no longer exists|selected court does not exist/i, 'ไม่พบสนามนี้ (อาจถูกปิดหรือลบไปแล้ว)'],
  [/customer name is too long/i, 'ชื่อลูกค้ายาวเกินไป'],
  [/the total must be more than 0/i, 'ยอดรวมต้องมากกว่า 0 บาท'],
  [/payment_method must be/i, 'กรุณาเลือกวิธีชำระเงิน'],
  [/could not allocate a unique .* code/i, 'สร้างรหัสรายการไม่สำเร็จ กรุณาลองใหม่'],

  // Slips and payments
  [/slip image was already used/i, 'สลิปนี้เคยใช้กับการจองอื่นแล้ว กรุณาส่งสลิปของการโอนครั้งนี้'],
  [/replaced this slip after you opened it/i, 'ลูกค้าเปลี่ยนสลิปหลังจากที่คุณเปิดดู — กดรีเฟรชแล้วตรวจสลิปใหม่ก่อนอนุมัติ'],
  [/slot is no longer available - refund the customer instead/i, 'ชำระล่าช้าและช่วงเวลานั้นมีคนจองไปแล้ว — ให้คืนเงินลูกค้าแทน'],
  [/([\d.]+) THB of this payment was refunded/i, m => `รายการนี้บันทึกคืนเงินไปแล้ว ${baht(m[1])} บาท อนุมัติไม่ได้ — ยกเลิกหรือคืนเงินส่วนที่เหลือแทน`],
  [/slip must be a JPG, PNG or WEBP/i, 'สลิปต้องเป็นรูป JPG, PNG หรือ WEBP'],
  [/slip image must be 5 MB or smaller/i, 'รูปสลิปต้องไม่เกิน 5 MB'],
  [/missing file|could not read the slip image|failed to store slip image/i, 'อ่านรูปสลิปไม่ได้ กรุณาเลือกรูปใหม่'],
  [/expected_slip_uploaded_at is required/i, 'กรุณารีเฟรชคิวสลิปแล้วลองใหม่'],

  // Cancel, refund, cash, no-show
  [/changed meanwhile - reload and try again/i, 'ข้อมูลถูกเปลี่ยนระหว่างนี้ กรุณารีเฟรชแล้วลองใหม่'],
  [/is (\w+) and can't be cancelled/i, m => `ชั่วโมงนี้ยกเลิกไม่ได้แล้ว (สถานะ ${m[1]})`],
  [/nothing left to cancel/i, 'ไม่มีชั่วโมงที่ยกเลิกได้แล้ว'],
  [/nothing to confirm/i, 'ไม่มีรายการที่ต้องยืนยัน'],
  [/nothing to refund - every paid hour still stands/i, 'ยังไม่มีเงินให้คืน — ทุกชั่วโมงที่จ่ายแล้วยังจองอยู่ (ให้ยกเลิกชั่วโมงพร้อมคืนเงินแทน)'],
  [/at most ([\d.]+) THB can be refunded/i, m => `คืนเงินได้ไม่เกิน ${baht(m[1])} บาท (ที่เหลือเป็นค่าชั่วโมงที่ยังจองอยู่)`],
  [/refund must be more than 0 and at most ([\d.]+)/i, m => `ยอดคืนเงินต้องมากกว่า 0 และไม่เกิน ${baht(m[1])} บาท`],
  [/no money was received to refund/i, 'ยังไม่ได้รับเงินสำหรับรายการนี้ จึงไม่มีอะไรให้คืน'],
  [/some booking ids are not part of this booking/i, 'บางชั่วโมงที่เลือกไม่ได้อยู่ในการจองนี้'],
  [/this booking was paid at the counter/i, 'การจองนี้ชำระที่เคาน์เตอร์แล้ว'],
  [/a transfer slip is waiting for review/i, 'มีสลิปโอนรอตรวจอยู่ — อนุมัติหรือปฏิเสธสลิปแทนการบันทึกเงินสด'],
  [/part of this payment was refunded - it can't be recorded as paid in cash/i, 'รายการนี้บันทึกคืนเงินไปแล้วบางส่วน บันทึกเป็นเงินสดไม่ได้'],
  [/no slip has been uploaded for this booking yet/i, 'การจองนี้ยังไม่มีสลิป อนุมัติไม่ได้'],
  [/idempotency_key must be/i, 'รหัสรายการไม่ถูกต้อง กรุณาลองใหม่'],
  [/the hour hasn't started yet/i, 'ชั่วโมงนี้ยังไม่เริ่ม บันทึกว่าไม่มาไม่ได้'],
  [/payment is already (\w+)/i, m => `รายการนี้ถูกดำเนินการไปแล้ว (${m[1]})`],
  [/(?:payment|booking) is (\w+)$/i, m => `รายการนี้อยู่ในสถานะ ${m[1]} ทำรายการนี้ไม่ได้`],
  [/reason is required|rejection reason|refund reason|cancellation reason/i, 'กรุณาใส่เหตุผล'],

  // Cash drawer shifts
  [/a shift is already open/i, 'มีกะที่เปิดอยู่แล้ว ปิดกะเดิมก่อน'],
  [/open the cash drawer shift before taking cash/i, 'ต้องเปิดกะลิ้นชักก่อนรับเงินสด (แท็บ "ยอดลิ้นชักวันนี้")'],
  [/no shift is open/i, 'ยังไม่ได้เปิดกะ'],
  [/the count is ([\d.]+) THB off - add a note/i, m => `ยอดนับต่างจากที่ควรมี ${baht(m[1])} บาท กรุณาใส่หมายเหตุอธิบาย`],
  [/opening float must be between/i, 'เงินทอนตั้งต้นต้องอยู่ระหว่าง 0 - 1,000,000 บาท'],
  [/counted cash must be 0 or more|counted_cash is required/i, 'กรุณาใส่ยอดเงินสดที่นับได้ (0 ขึ้นไป)'],

  // Counter sales, rentals, stock
  [/only today's sales can be voided/i, 'ยกเลิกได้เฉพาะบิลของวันนี้'],
  [/is already voided/i, 'บิลนี้ถูกยกเลิกไปแล้ว'],
  [/was paid in a shift that is already closed/i, 'บิลเงินสดนี้อยู่ในกะที่ปิดไปแล้ว ยกเลิกไม่ได้'],
  [/was voided - its items are already back in stock/i, 'บิลนี้ถูกยกเลิกแล้ว ของกลับเข้าสต๊อกแล้ว'],
  [/already returned on/i, 'รายการนี้คืนของแล้ว'],
  [/(.+?) size (.+?): only (\d+) left/i, m => `${detail(m[1])} เบอร์ ${m[2]}: เหลือ ${m[3]} คู่`],
  [/only (\d+) left of (.+?) size (.+)/i, m => `${m[2]} เบอร์ ${m[3]}: เหลือ ${m[1]} คู่`],
  [/(.+?): only (\d+) in stock/i, m => `${detail(m[1])}: เหลือในคลัง ${m[2]} ชิ้น`],
  [/only (\d+) of (.+?) in stock/i, m => `${m[2]}: เหลือในคลัง ${m[1]} ชิ้น`],
  [/out of stock/i, 'สินค้าหมด'],
  [/is a rental item - use the rental form/i, 'สินค้านี้เป็นของให้เช่า ใช้แท็บ "ยืม/เช่า"'],
  [/is for sale, not rental|is a sale, not a rental/i, 'สินค้านี้เป็นของขาย ไม่ใช่ของให้เช่า'],
  [/choose the size of|unknown size for|has no sizes/i, 'กรุณาเลือกเบอร์ (ไซซ์)'],
  [/is stocked per size/i, 'สินค้านี้นับสต๊อกแยกตามเบอร์ — เลือกเบอร์ก่อนปรับ'],
  [/is not on sale/i, 'สินค้านี้ปิดการขายอยู่'],
  [/quantity for (.+?) must be between 1 and (\d+)/i, m => `จำนวน ${m[1]} ต้องอยู่ระหว่าง 1 - ${m[2]}`],
  [/an order needs between 1 and 50 lines/i, 'บิลหนึ่งมีได้ 1 - 50 รายการ'],
  [/product .* does not exist/i, 'ไม่พบสินค้านี้'],
  [/product name is required/i, 'กรุณาใส่ชื่อสินค้า (ไม่เกิน 200 ตัวอักษร)'],
  [/price must be between/i, 'ราคาต้องอยู่ระหว่าง 0 - 100,000 บาท'],
  [/stock must be between/i, 'จำนวนสต๊อกต้องอยู่ระหว่าง 0 - 100,000'],
  [/delta must be a non-zero/i, 'จำนวนที่ปรับต้องไม่เป็น 0'],
  [/send between 1 and 500 products/i, 'นำเข้าได้ครั้งละ 1 - 500 รายการ'],

  // Points and vouchers
  [/it costs (\d+) points, you have (\d+)/i, m => `ต้องใช้ ${m[1]} แต้ม แต่คุณมี ${m[2]} แต้ม`],
  [/not enough points|insufficient points/i, 'แต้มไม่พอ'],
  [/no voucher (\S+)/i, m => `ไม่พบรหัสคูปอง ${m[1]}`],
  [/expired on/i, 'คูปองนี้หมดอายุแล้ว'],
  [/is a free court hour - book the hour with it in the walk-in form/i, 'คูปองนี้เป็นชั่วโมงฟรี ใช้จองที่ฟอร์ม Walk-in'],
  [/voucher, not a free court hour|voucher can't be used for a free hour/i, 'คูปองนี้ไม่ใช่ชั่วโมงฟรี'],
  [/a free-hour voucher covers exactly one hour/i, 'คูปองชั่วโมงฟรีใช้ได้ครั้งละ 1 ชั่วโมง'],
  [/free-hour voucher is for off-peak hours only/i, 'คูปองชั่วโมงฟรีใช้ได้เฉพาะช่วง Off-Peak'],
  [/voucher (\S+) is (\w+)/i, m => `คูปอง ${m[1]} ใช้ไม่ได้ (${m[2]})`],

  // Courts, closures, pricing settings
  [/a court named "?(.+?)"? already exists/i, m => `มีสนามชื่อ ${m[1]} อยู่แล้ว`],
  [/a half court must be part of a full court/i, 'ครึ่งสนามต้องเลือกว่าเป็นครึ่งของสนามใด'],
  [/a half court must be part of a full (\w+) court/i, m => `ครึ่งสนามต้องเป็นครึ่งของสนามเต็มประเภท ${m[1]}`],
  [/court name is required/i, 'กรุณาใส่ชื่อสนาม (ไม่เกิน 100 ตัวอักษร)'],
  [/cannot close a date in the past/i, 'ปิดวันที่ผ่านมาแล้วไม่ได้'],
  [/partial closure needs start_hour < end_hour/i, 'ปิดบางช่วง: เวลาเริ่มต้องน้อยกว่าเวลาสิ้นสุด'],
  [/overlaps the active rule "(.+?)" \((\d\d:00)-(\d\d:00)\)/i, m => `ช่วงเวลาซ้อนกับกติกา "${m[1]}" (${m[2]}-${m[3]}) — แก้ไขหรือปิดกติกานั้นก่อน`],
  [/price_per_hour must be more than 0/i, 'ราคาต่อชั่วโมงต้องมากกว่า 0 บาท'],
  [/start_hour must be before end_hour/i, 'เวลาเริ่มต้องน้อยกว่าเวลาสิ้นสุด (00:00-24:00)'],
  [/opening hours must satisfy/i, 'เวลาเปิดต้องน้อยกว่าเวลาปิด (00:00-24:00)'],
  [/max_advance_days must be between 1 and (\d+)/i, m => `จำนวนวันจองล่วงหน้าต้องอยู่ระหว่าง 1 - ${m[1]} วัน`],
  [/half_court_rate_percent must be between/i, 'ราคาครึ่งสนามต้องอยู่ระหว่าง 1 - 100%'],
  [/discount_percent must be/i, 'ส่วนลดต้องอยู่ระหว่าง 0 - 99%'],
  [/(?:month|date|from|to)(?: query parameter)? must be YYYY-MM(?:-DD)?|invalid date format/i, 'รูปแบบวันที่ไม่ถูกต้อง'],

  // General
  [/(?:^|: )name is required/i, 'กรุณาใส่ชื่อ (ไม่เกิน 100 ตัวอักษร)'],
  [/busy with the same booking|system was busy/i, 'ระบบกำลังทำรายการเดียวกันอยู่ กรุณาลองใหม่อีกครั้ง'],
  [/^not allowed/i, 'ไม่มีสิทธิ์ทำรายการนี้'],
  [/^(?:not found|user not found)/i, 'ไม่พบรายการนี้ (อาจถูกลบหรือเปลี่ยนไปแล้ว)'],
  [/login failed, please try again|registration failed, please try again|^Request failed \(5\d\d\)/i, 'เซิร์ฟเวอร์ขัดข้อง กรุณาลองใหม่อีกครั้ง'],
  [/^invalid state for this action$/i, 'รายการนี้ถูกเปลี่ยนสถานะไปแล้ว กรุณารีเฟรชดูสถานะล่าสุด']
];

export function thaiErrorText(message: string): string {
  for (const [re, out] of RULES) {
    const m = message.match(re);
    if (m) return typeof out === 'string' ? out : out(m);
  }
  return message;
}
