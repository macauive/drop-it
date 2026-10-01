"""Generate synthetic PDF edge cases; no passwords or user files are retained."""
from io import BytesIO
from pathlib import Path
import secrets

from PIL import Image, ImageDraw, ImageFont
from pypdf import PdfReader, PdfWriter
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader

output = Path(__file__).parent / "fixtures"
output.mkdir(exist_ok=True)
plain = BytesIO()
page = canvas.Canvas(plain, pagesize=(612, 792))
page.drawString(40, 740, "Synthetic PDF validation fixture")
page.save()
for filename, password in [
    ("password-protected.pdf", secrets.token_urlsafe(24)),
    ("owner-encrypted.pdf", ""),
]:
    writer = PdfWriter()
    writer.append(PdfReader(BytesIO(plain.getvalue())))
    writer.encrypt(password, owner_password=secrets.token_urlsafe(24), algorithm="AES-256")
    writer.write(output / filename)

image = Image.new("RGB", (1100, 600), "white")
draw = ImageDraw.Draw(image)
font = ImageFont.load_default(size=32)
draw.text((60, 80), "Basil growing notes", fill="black", font=font)
draw.text((60, 160), "Place basil in a sunny kitchen window.", fill="black", font=font)
draw.text((60, 230), "Water when the soil surface is dry.", fill="black", font=font)
scan = canvas.Canvas(str(output / "scanned.pdf"), pagesize=(660, 360))
scan.drawImage(ImageReader(image), 0, 0, width=660, height=360)
scan.save()
