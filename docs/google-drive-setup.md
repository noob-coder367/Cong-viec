# Kết nối Google Drive cho Cong-viec

## Những gì đã có trong code

- OAuth server-side với scope `https://www.googleapis.com/auth/drive`.
- Token làm mới được mã hóa AES-256-GCM trước khi lưu vào `public.google_drive_connections`.
- Giao diện riêng yêu cầu `DRIVE_ADMIN_PIN`, tách biệt PIN chat.
- Duyệt thư mục, tìm kiếm theo tên trên toàn Drive, phân trang, tạo thư mục / Google Docs / Sheets / Slides, tải file tối đa 25 MB, mở file, đổi tên, di chuyển, chia sẻ quyền xem/chỉnh sửa, chuyển vào thùng rác và khôi phục.
- Dữ liệu Drive không được đưa vào Supabase Storage; file được tạo/lưu trong chính Google Drive.

## Thiết lập một lần

1. Mở [Google Cloud Console](https://console.cloud.google.com/), chọn hoặc tạo project dành cho Cong-viec.
2. Trong **APIs & Services → Library**, bật **Google Drive API**.
3. Cấu hình **OAuth consent screen / Google Auth Platform**. Nếu ứng dụng đang ở chế độ Testing, thêm tài khoản Google của m vào danh sách test users.
4. Tạo **OAuth Client ID → Web application**.
5. Thêm chính xác URI này vào **Authorized redirect URIs**:

   `https://cong-viec.onrender.com/auth/google/callback`

6. Trong Render → service **Cong-viec** → **Environment**, đặt các biến sau. Không gửi giá trị bí mật vào chat và không commit chúng vào Git.

   - `DRIVE_ADMIN_PIN`: PIN riêng gồm 6 chữ số, khác PIN chat.
   - `GOOGLE_CLIENT_ID`: Client ID từ Google Cloud.
   - `GOOGLE_CLIENT_SECRET`: Client Secret từ Google Cloud.
   - `GOOGLE_REDIRECT_URI=https://cong-viec.onrender.com/auth/google/callback`
   - `FRONTEND_URL=https://cong-viec-ptung1.vercel.app`
   - `GOOGLE_TOKEN_ENCRYPTION_KEY`: khóa bí mật ngẫu nhiên dài, giữ nguyên sau khi kết nối lần đầu. Nếu đổi khóa, token đang lưu sẽ không giải mã được.
   - `SUPABASE_SERVICE_ROLE_KEY` (hoặc `SUPABASE_SECRET_KEY`): khóa server-only của đúng project Supabase Cong-viec; không dùng khóa của Web-10A4-NHH.
   - Đảm bảo `SUPABASE_URL` trỏ đến đúng project Cong-viec.

   Có thể tạo khóa mã hóa trong terminal bằng Node.js:
   `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`

7. Lưu Environment để Render redeploy. Mở [Cong-viec](https://cong-viec-ptung1.vercel.app), vào chat, bấm **Google Drive**, nhập Drive Admin PIN riêng, rồi bấm **Kết nối Google** và chọn đúng tài khoản Google.

## Quyền truy cập và giới hạn

Scope `drive` cho phép xem và quản lý tất cả file trong Drive được Google cấp quyền, nên rất rộng. Hãy chỉ kết nối tài khoản của chính m và giữ PIN riêng tư. Google có thể yêu cầu xác minh ứng dụng đối với scope nhạy cảm/bị hạn chế; trong lúc phát triển có thể cần thêm tài khoản làm test user.

Phiên bản hiện tại chuyển file vào thùng rác thay vì xóa vĩnh viễn. Tệp tải lên bị giới hạn 25 MB để tránh dùng quá nhiều RAM trên backend. Tính năng chỉnh sửa nội dung tài liệu mở trình chỉnh sửa chính thức của Google; chỉnh sửa nội dung trực tiếp bên trong giao diện Cong-viec là một giai đoạn riêng.
