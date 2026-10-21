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

  it('passes unknown and already-Thai messages through', () => {
    expect(thaiErrorText('something new happened')).toBe('something new happened');
    expect(thaiErrorText('ไม่พบสินค้านี้')).toBe('ไม่พบสินค้านี้');
  });
});
