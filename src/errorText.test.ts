import { describe, it, expect } from 'vitest';
import { thaiErrorText } from './errorText';

// Messages exactly as the Go backend sends them (sentinel + ": " + detail).
describe('thaiErrorText', () => {
  it('translates sign-in and sign-up errors', () => {
    expect(thaiErrorText('invalid login credentials')).toBe('เบอร์โทร/อีเมล หรือรหัสผ่านไม่ถูกต้อง');
    expect(thaiErrorText('too many failed logins - try again in 12 minutes')).toBe('ลองผิดหลายครั้งเกินไป กรุณารอ 12 นาทีแล้วลองใหม่');
    expect(thaiErrorText('invalid registration details: name is required (max 100 characters)')).toBe('กรุณาใส่ชื่อ (ไม่เกิน 100 ตัวอักษร)');
  });

  it('keeps the court and time of a taken slot', () => {
    expect(thaiErrorText('slot already booked: สนามแบดมินตัน 3 18:00-19:00 is already reserved'))
      .toBe('สนามแบดมินตัน 3 18:00-19:00 ถูกจองไปแล้ว กรุณาเลือกเวลาอื่น');
  });

  it('keeps a court name that contains ": "', () => {
    expect(thaiErrorText('slot already booked: สนามบาสเกตบอล B (ครึ่งสนาม: ซ้าย) 18:00-19:00 is already reserved'))
      .toBe('สนามบาสเกตบอล B (ครึ่งสนาม: ซ้าย) 18:00-19:00 ถูกจองไปแล้ว กรุณาเลือกเวลาอื่น');
  });

  it('translates session and permission errors', () => {
    expect(thaiErrorText('session expired - please log in again')).toBe('เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่');
    expect(thaiErrorText('login required')).toBe('กรุณาเข้าสู่ระบบก่อน');
    expect(thaiErrorText('your role is not allowed to do this')).toBe('บัญชีนี้ไม่มีสิทธิ์ทำรายการนี้');
    expect(thaiErrorText('could not check your session right now - please try again')).toBe('ตรวจสอบการเข้าสู่ระบบไม่ได้ชั่วคราว กรุณาลองใหม่');
    expect(thaiErrorText('internal server error - please try again')).toBe('เซิร์ฟเวอร์ขัดข้อง กรุณาลองใหม่อีกครั้ง');
  });

  it('translates staff and manager errors with their numbers', () => {
    expect(thaiErrorText('invalid booking request: at most 180.00 THB can be refunded (the rest pays for hours still booked)'))
      .toBe('คืนเงินได้ไม่เกิน 180 บาท (ที่เหลือเป็นค่าชั่วโมงที่ยังจองอยู่)');
    expect(thaiErrorText('invalid state for this action: REC20261021-7473EF was paid in a shift that is already closed - it can\'t be voided now'))
      .toBe('บิลเงินสดนี้อยู่ในกะที่ปิดไปแล้ว ยกเลิกไม่ได้');
    expect(thaiErrorText('invalid booking request: the count is 25.50 THB off - add a note explaining it'))
      .toBe('ยอดนับเกินจากที่ควรมี 25.5 บาท กรุณาใส่หมายเหตุอธิบาย');
    expect(thaiErrorText('invalid booking request: the count is -10.00 THB off - add a note explaining it'))
      .toBe('ยอดนับขาดจากที่ควรมี 10 บาท กรุณาใส่หมายเหตุอธิบาย');
    expect(thaiErrorText('out of stock: น้ำดื่ม 600ml: only 2 in stock')).toBe('น้ำดื่ม 600ml: เหลือในคลัง 2 ชิ้น');
    expect(thaiErrorText('invalid booking request: overlaps the active rule "แบด เย็น" (17:00-22:00) - adjust or deactivate it first'))
      .toBe('ช่วงเวลาซ้อนกับกติกา "แบด เย็น" (17:00-22:00) — แก้ไขหรือปิดกติกานั้นก่อน');
    expect(thaiErrorText('row 3: invalid booking request: price must be between 0 and 100000')).toBe('แถวที่ 3: ราคาต้องอยู่ระหว่าง 0 - 100,000 บาท');
    expect(thaiErrorText('invalid state for this action: payment is REFUNDED')).toBe('รายการนี้อยู่ในสถานะ REFUNDED ทำรายการนี้ไม่ได้');
  });

  it('translates the newer money-rule and court messages', () => {
    expect(thaiErrorText('invalid state for this action: a transfer slip is waiting for review - approve or reject the slip instead of recording cash'))
      .toBe('มีสลิปโอนรอตรวจอยู่ — อนุมัติหรือปฏิเสธสลิปแทนการบันทึกเงินสด');
    expect(thaiErrorText('invalid booking request: a half court must be part of a full BASKETBALL court')).toBe('ครึ่งสนามต้องเป็นครึ่งของสนามเต็มประเภท BASKETBALL');
    expect(thaiErrorText('the system was busy - please try again')).toBe('ระบบกำลังทำรายการเดียวกันอยู่ กรุณาลองใหม่อีกครั้ง');
    expect(thaiErrorText('too many sign-ups from this network - try again later')).toBe('สมัครสมาชิกจากเครือข่ายนี้บ่อยเกินไป กรุณาลองใหม่ภายหลัง');
  });

  it('translates the business-details messages', () => {
    expect(thaiErrorText('invalid booking request: the tax ID must have 13 digits')).toBe('เลขประจำตัวผู้เสียภาษีต้องมี 13 หลัก');
    expect(thaiErrorText('invalid booking request: a VAT-registered business needs its name, address and tax ID'))
      .toBe('ถ้าจด VAT ต้องใส่ชื่อ ที่อยู่ และเลขประจำตัวผู้เสียภาษี');
  });

  it('translates the retry and timeout messages', () => {
    expect(thaiErrorText('the same request is still being processed - check the result before trying again')).toBe('รายการเดิมกำลังบันทึกอยู่ กรุณาตรวจผลก่อนกดซ้ำ');
    expect(thaiErrorText('the request took too long - please try again')).toBe('ระบบตอบช้าเกินไป กรุณาลองใหม่อีกครั้ง');
  });

  it('translates the no-show grace message', () => {
    expect(thaiErrorText('invalid state for this action: a no-show can be marked from 15 minutes after the hour starts')).toBe('บันทึก "ไม่มา" ได้หลังเริ่มเวลาไปแล้ว 15 นาที');
    expect(thaiErrorText('slot already booked: the hour was already sold to another customer')).toBe('ชั่วโมงนี้ขายให้ลูกค้าคนอื่นไปแล้ว — ยกเลิก "ไม่มา" ไม่ได้');
    expect(thaiErrorText('invalid state for this action: booking is CONFIRMED, not a no-show')).toBe('การจองนี้ไม่ได้อยู่ในสถานะ "ไม่มา" แล้ว (รีเฟรชหน้าจอ)');
  });

  it('passes unknown and already-Thai messages through', () => {
    expect(thaiErrorText('something new happened')).toBe('something new happened');
    expect(thaiErrorText('ไม่พบสินค้านี้')).toBe('ไม่พบสินค้านี้');
  });

  it('translates the messages added by the 2026-10-22 security fixes', () => {
    const th = (m: string) => thaiErrorText(m);
    expect(th("not allowed: you can't approve the payment for your own booking")).toBe('อนุมัติการชำระเงินของการจองตัวเองไม่ได้ — ให้พนักงานคนอื่นหรือผู้จัดการอนุมัติ');
    expect(th('not allowed: role "ผู้บริหาร (Admin)" has permissions you don\'t have (manage_roles)')).toBe('ให้บทบาท "ผู้บริหาร (Admin)" ไม่ได้ — บทบาทนี้มีสิทธิ์ที่คุณไม่มี');
    expect(th("not allowed: this account has permissions you don't have (view_reports)")).toBe('แก้บัญชีนี้ไม่ได้ — บัญชีนี้มีสิทธิ์ที่คุณไม่มี (ให้ผู้ดูแลระบบทำ)');
    expect(th('invalid state for this action: this slip was never approved - check that the transfer is in the bank account, then confirm the refund')).toBe('สลิปนี้ยังไม่เคยได้รับอนุมัติ — ตรวจในบัญชีธนาคารว่าเงินเข้าจริงก่อน แล้วยืนยันการคืนเงิน');
    expect(th('invalid state for this action: this payment has no refund waiting for a check')).toBe('รายการนี้ไม่มีการคืนเงินที่รอตรวจแล้ว (รีเฟรชหน้าจอ)');
    expect(th("invalid booking request: the count doesn't match - count again, or add a note explaining the difference")).toBe('ยอดเงินที่นับไม่ตรง — นับใหม่ หรือใส่หมายเหตุอธิบายส่วนต่าง');
    expect(th('invalid booking request: reason is too long (at most 500 characters)')).toBe('เหตุผลยาวเกินไป (ไม่เกิน 500 ตัวอักษร)');
    expect(th('invalid booking request: notes is too long (at most 500 characters)')).toBe('หมายเหตุยาวเกินไป (ไม่เกิน 500 ตัวอักษร)');
    expect(th('invalid state for this action: this booking already has 5 slips - please contact staff')).toBe('การจองนี้ส่งสลิปมาแล้ว 5 ครั้ง — กรุณาติดต่อพนักงาน');
    expect(th('invalid state for this action: too many slips sent today - please contact staff')).toBe('วันนี้ส่งสลิปหลายครั้งเกินไป — กรุณาติดต่อพนักงาน');
    expect(th('slip must be a real JPG, PNG or WEBP image')).toBe('ไฟล์นี้ไม่ใช่รูปสลิป — กรุณาส่งรูปภาพ JPG, PNG หรือ WEBP');
    expect(th('slip image dimensions are too large')).toBe('รูปสลิปใหญ่เกินไป — กรุณาใช้ภาพหน้าจอสลิป');
    expect(th('invalid request body: wrong type for amount')).toBe('ข้อมูลที่ส่งไม่ถูกต้อง (amount) — กรุณารีเฟรชหน้าแล้วลองใหม่');
    expect(th('invalid request body: reason is missing or invalid')).toBe('ข้อมูลที่ส่งไม่ถูกต้อง (reason) — กรุณารีเฟรชหน้าแล้วลองใหม่');
    expect(th('invalid request body')).toBe('ข้อมูลที่ส่งไม่ถูกต้อง — กรุณารีเฟรชหน้าแล้วลองใหม่');
  });
});
