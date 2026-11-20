using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace RemoteCode.Desktop
{
    public static class DpiMode
    {
        [DllImport("user32.dll")]
        private static extern bool SetProcessDpiAwarenessContext(IntPtr context);
        [DllImport("user32.dll")]
        private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
        [DllImport("user32.dll")]
        private static extern bool SetProcessDPIAware();
        [DllImport("user32.dll")]
        private static extern uint GetDpiForWindow(IntPtr window);

        public static void Enable()
        {
            IntPtr perMonitorV2 = new IntPtr(-4);
            try { SetProcessDpiAwarenessContext(perMonitorV2); }
            catch (EntryPointNotFoundException) { }
            try
            {
                if (SetThreadDpiAwarenessContext(perMonitorV2) != IntPtr.Zero) return;
            }
            catch (EntryPointNotFoundException) { }
            SetProcessDPIAware();
        }

        public static int ForWindow(Control control)
        {
            try
            {
                uint dpi = GetDpiForWindow(control.Handle);
                if (dpi != 0) return (int)dpi;
            }
            catch (EntryPointNotFoundException) { }
            using (Graphics graphics = control.CreateGraphics())
                return (int)Math.Round(graphics.DpiX);
        }
    }

    internal static class Surface
    {
        public static GraphicsPath Shape(RectangleF bounds, float radius)
        {
            var path = new GraphicsPath();
            float diameter = Math.Min(radius * 2, Math.Min(bounds.Width, bounds.Height));
            if (diameter <= 0)
            {
                path.AddRectangle(bounds);
                return path;
            }
            path.AddArc(bounds.X, bounds.Y, diameter, diameter, 180, 90);
            path.AddArc(bounds.Right - diameter, bounds.Y, diameter, diameter, 270, 90);
            path.AddArc(bounds.Right - diameter, bounds.Bottom - diameter, diameter, diameter, 0, 90);
            path.AddArc(bounds.X, bounds.Bottom - diameter, diameter, diameter, 90, 90);
            path.CloseFigure();
            return path;
        }

        public static void Fill(Graphics g, Size size, float radius, Color color)
        {
            if (size.Width < 2 || size.Height < 2) return;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            var bounds = new RectangleF(0.5f, 0.5f, size.Width - 1, size.Height - 1);
            using (var path = Shape(bounds, radius))
            using (var brush = new SolidBrush(color))
                g.FillPath(brush, path);
        }
    }

    public sealed class RoundedCard : Panel
    {
        public Color FillColor { get; set; }

        public RoundedCard()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint |
                ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw |
                ControlStyles.SupportsTransparentBackColor, true);
            BackColor = Color.Transparent;
            FillColor = Color.White;
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Surface.Fill(e.Graphics, ClientSize, 18 * DpiMode.ForWindow(this) / 96f, FillColor);
            base.OnPaint(e);
        }
    }

    public sealed class RoundedButton : Button
    {
        private bool hot;
        private bool pressed;
        public Color FillColor { get; set; }
        public Color HoverColor { get; set; }
        public Color PressedColor { get; set; }

        public RoundedButton()
        {
            FlatStyle = FlatStyle.Flat;
            FlatAppearance.BorderSize = 0;
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint |
                ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
        }

        protected override void OnMouseEnter(EventArgs e) { hot = true; Invalidate(); base.OnMouseEnter(e); }
        protected override void OnMouseLeave(EventArgs e) { hot = false; pressed = false; Invalidate(); base.OnMouseLeave(e); }
        protected override void OnMouseDown(MouseEventArgs e) { if (e.Button == MouseButtons.Left) pressed = true; Invalidate(); base.OnMouseDown(e); }
        protected override void OnMouseUp(MouseEventArgs e) { pressed = false; Invalidate(); base.OnMouseUp(e); }
        protected override void OnKeyDown(KeyEventArgs e) { if (e.KeyCode == Keys.Space) pressed = true; Invalidate(); base.OnKeyDown(e); }
        protected override void OnKeyUp(KeyEventArgs e) { pressed = false; Invalidate(); base.OnKeyUp(e); }
        protected override void OnLostFocus(EventArgs e) { pressed = false; Invalidate(); base.OnLostFocus(e); }

        protected override void OnPaint(PaintEventArgs e)
        {
            using (var background = new SolidBrush(BackColor))
                e.Graphics.FillRectangle(background, ClientRectangle);
            Color fill = !Enabled ? Color.FromArgb(238, 237, 234) : pressed ? PressedColor : hot ? HoverColor : FillColor;
            float scale = DpiMode.ForWindow(this) / 96f;
            Surface.Fill(e.Graphics, ClientSize, 11 * scale, fill);
            Color ink = Enabled ? ForeColor : SystemColors.GrayText;
            TextRenderer.DrawText(e.Graphics, Text, Font, ClientRectangle, ink,
                TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter |
                TextFormatFlags.SingleLine | TextFormatFlags.EndEllipsis);
            if (Enabled && Focused && ShowFocusCues && Width > 8 && Height > 8)
            {
                var bounds = new RectangleF(3 * scale, 3 * scale, Width - 6 * scale, Height - 6 * scale);
                using (var path = Surface.Shape(bounds, 8 * scale))
                using (var pen = new Pen(ink, 1.4f * scale))
                    e.Graphics.DrawPath(pen, path);
            }
        }
    }
}
