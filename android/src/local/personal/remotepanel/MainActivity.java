package local.personal.remotepanel;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.inputmethod.InputMethodManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;

public class MainActivity extends Activity {
    private static final int BG_WARM_GRAY = Color.rgb(245, 244, 241);
    private static final int INK_PRIMARY = Color.rgb(31, 35, 40);
    private static final int INK_SECONDARY = Color.rgb(82, 91, 101);
    private static final int INDIGO = Color.rgb(79, 70, 229);

    private static final long SLOW_WAIT_MS = 10_000L;
    private static final long CONNECT_TIMEOUT_MS = 35_000L;
    private static final String OFFLINE_NOTE = "请确认 Tailscale 已连接，电脑上的远程面板仍在运行。";

    private Uri endpoint;
    private WebView web;
    private FrameLayout content;
    private LinearLayout loading;
    private TextView loadingLabel;
    private LinearLayout offline;
    private TextView offlineNote;
    private LinearLayout setup;
    private EditText address;
    private boolean failed;
    private boolean openedTailscale;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private Runnable slowWait;
    private Runnable connectTimeout;
    private long attempt;

    @Override
    public void onCreate(Bundle saved) {
        super.onCreate(saved);
        configureSystemBars();

        endpoint = parseAddress(getPreferences(MODE_PRIVATE).getString("address", PanelAddress.URL));
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(BG_WARM_GRAY);
        root.setOnApplyWindowInsetsListener(new View.OnApplyWindowInsetsListener() {
            @Override
            public WindowInsets onApplyWindowInsets(View view, WindowInsets insets) {
                view.setPadding(
                    insets.getSystemWindowInsetLeft(),
                    insets.getSystemWindowInsetTop(),
                    insets.getSystemWindowInsetRight(),
                    insets.getSystemWindowInsetBottom()
                );
                return insets;
            }
        });

        web = new WebView(this);
        web.setBackgroundColor(BG_WARM_GRAY);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSupportMultipleWindows(false);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        web.addJavascriptInterface(new Bridge(), "AndroidBridge");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !sameOrigin(request.getUrl());
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame() && sameOrigin(request.getUrl())) showOffline();
            }

            @Override
            public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse error) {
                if (request.isForMainFrame() && sameOrigin(request.getUrl()) && error.getStatusCode() >= 400) showOffline();
            }

            @Override
            public void onPageCommitVisible(WebView view, String url) {
                if (url != null && endpoint != null && sameOrigin(Uri.parse(url))) markConnected();
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                if (url != null && endpoint != null && sameOrigin(Uri.parse(url))) markConnected();
            }
        });

        content = new FrameLayout(this);
        content.addView(web, new FrameLayout.LayoutParams(-1, -1));
        root.addView(content, new FrameLayout.LayoutParams(-1, -1));

        loading = buildLoadingView();
        root.addView(loading, new FrameLayout.LayoutParams(-1, -1));

        offline = buildOfflineView();
        root.addView(offline, new FrameLayout.LayoutParams(-1, -1));

        setup = buildSetupView();
        root.addView(setup, new FrameLayout.LayoutParams(-1, -1));

        setContentView(root);
        if (endpoint == null) showSetup(); else connect();
    }

    private void configureSystemBars() {
        getWindow().setStatusBarColor(BG_WARM_GRAY);
        getWindow().setNavigationBarColor(BG_WARM_GRAY);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            View decor = getWindow().getDecorView();
            int flags = decor.getSystemUiVisibility() | View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                flags |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            }
            decor.setSystemUiVisibility(flags);
        }
    }

    private LinearLayout buildCardContainer() {
        LinearLayout outer = new LinearLayout(this);
        outer.setOrientation(LinearLayout.VERTICAL);
        outer.setGravity(Gravity.CENTER);
        outer.setPadding(dp(24), dp(24), dp(24), dp(24));
        return outer;
    }

    private LinearLayout buildInnerCard() {
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(24), dp(24), dp(24), dp(24));
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(Color.WHITE);
        bg.setCornerRadius(dp(18));
        bg.setStroke(dp(1), Color.argb(24, 31, 35, 40));
        card.setBackground(bg);
        card.setElevation(dp(4));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
            Math.min(getResources().getDisplayMetrics().widthPixels - dp(40), dp(420)),
            ViewGroup.LayoutParams.WRAP_CONTENT
        );
        card.setLayoutParams(params);
        return card;
    }

    private Button styledButton(String label, boolean primary) {
        Button btn = new Button(this);
        btn.setText(label);
        btn.setAllCaps(false);
        btn.setTextSize(15);
        btn.setTextColor(primary ? Color.WHITE : INK_PRIMARY);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(primary ? INDIGO : Color.rgb(240, 239, 234));
        bg.setCornerRadius(dp(12));
        btn.setBackground(bg);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-1, dp(46));
        lp.topMargin = dp(10);
        btn.setLayoutParams(lp);
        return btn;
    }

    private LinearLayout buildLoadingView() {
        LinearLayout outer = buildCardContainer();
        LinearLayout card = buildInnerCard();

        TextView title = new TextView(this);
        title.setText("正在打开远程面板");
        title.setTextColor(INK_PRIMARY);
        title.setTextSize(20);
        card.addView(title);

        loadingLabel = new TextView(this);
        loadingLabel.setTextColor(INK_SECONDARY);
        loadingLabel.setTextSize(14);
        loadingLabel.setPadding(0, dp(8), 0, dp(2));
        card.addView(loadingLabel);

        outer.addView(card);
        outer.setVisibility(View.GONE);
        return outer;
    }

    private void showLoading(String message) {
        loadingLabel.setText(message);
        loading.setVisibility(View.VISIBLE);
    }

    private void hideLoading() {
        loading.setVisibility(View.GONE);
    }

    private void cancelDeadlines() {
        attempt++;
        if (slowWait != null) { handler.removeCallbacks(slowWait); slowWait = null; }
        if (connectTimeout != null) { handler.removeCallbacks(connectTimeout); connectTimeout = null; }
    }

    private void markConnected() {
        if (offline.getVisibility() == View.VISIBLE || setup.getVisibility() == View.VISIBLE) return;
        cancelDeadlines();
        hideLoading();
        failed = false;
    }

    private LinearLayout buildOfflineView() {
        LinearLayout outer = buildCardContainer();
        LinearLayout card = buildInnerCard();

        TextView title = new TextView(this);
        title.setText("暂时无法连接电脑");
        title.setTextColor(INK_PRIMARY);
        title.setTextSize(20);
        card.addView(title);

        final TextView note = new TextView(this);
        note.setText(OFFLINE_NOTE);
        note.setTextColor(INK_SECONDARY);
        note.setTextSize(14);
        note.setPadding(0, dp(8), 0, dp(10));
        card.addView(note);
        offlineNote = note;

        Button retry = styledButton("重新连接", true);
        retry.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View view) { connect(); }
        });
        card.addView(retry);

        Button tailscale = styledButton("打开 Tailscale", false);
        tailscale.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View view) {
                Intent intent = getPackageManager().getLaunchIntentForPackage("com.tailscale.ipn");
                if (intent != null) {
                    openedTailscale = true;
                    startActivity(intent);
                } else {
                    note.setText("请先在设备上安装并连接 Tailscale。");
                }
            }
        });
        card.addView(tailscale);

        Button change = styledButton("更换电脑地址", false);
        change.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View view) { showSetup(); }
        });
        card.addView(change);

        outer.addView(card);
        return outer;
    }

    private LinearLayout buildSetupView() {
        LinearLayout outer = buildCardContainer();
        LinearLayout card = buildInnerCard();

        TextView setupTitle = new TextView(this);
        setupTitle.setText("连接你的电脑");
        setupTitle.setTextColor(INK_PRIMARY);
        setupTitle.setTextSize(20);
        card.addView(setupTitle);

        TextView setupNote = new TextView(this);
        setupNote.setText("粘贴电脑面板窗口里显示的 Tailscale HTTPS 地址。");
        setupNote.setTextColor(INK_SECONDARY);
        setupNote.setTextSize(14);
        setupNote.setPadding(0, dp(8), 0, dp(14));
        card.addView(setupNote);

        address = new EditText(this);
        address.setSingleLine(true);
        address.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        address.setHint("https://电脑名.网络名.ts.net:8443/");
        address.setContentDescription("电脑地址");
        address.setPadding(dp(14), dp(12), dp(14), dp(12));
        GradientDrawable inputBg = new GradientDrawable();
        inputBg.setColor(BG_WARM_GRAY);
        inputBg.setCornerRadius(dp(12));
        inputBg.setStroke(dp(1), Color.argb(38, 31, 35, 40));
        address.setBackground(inputBg);
        card.addView(address, new LinearLayout.LayoutParams(-1, dp(48)));

        Button connectBtn = styledButton("保存并连接", true);
        connectBtn.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View view) { saveAddress(); }
        });
        card.addView(connectBtn);

        outer.addView(card);
        return outer;
    }

    private final class Bridge {
        @JavascriptInterface
        public void openSetup() {
            runOnUiThread(new Runnable() {
                @Override public void run() { showSetup(); }
            });
        }
    }

    private boolean sameOrigin(Uri uri) {
        return endpoint != null && "https".equals(uri.getScheme()) && endpoint.getHost().equalsIgnoreCase(uri.getHost())
            && port(uri) == port(endpoint) && uri.getUserInfo() == null;
    }

    private static Uri parseAddress(String value) {
        String input = value.trim();
        if (input.isEmpty()) return null;
        if (!input.contains("://")) input = "https://" + input;
        try {
            URI uri = new URI(input);
            String host = uri.getHost();
            if (!"https".equalsIgnoreCase(uri.getScheme()) || host == null || uri.getUserInfo() != null
                || uri.getQuery() != null || uri.getFragment() != null || uri.getPort() > 65535
                || uri.getPort() == 0 || (!uri.getPath().isEmpty() && !"/".equals(uri.getPath()))) return null;
            host = host.toLowerCase(Locale.ROOT);
            if (!host.endsWith(".ts.net")) return null;
            return Uri.parse("https://" + host + (uri.getPort() == -1 ? "" : ":" + uri.getPort()) + "/");
        } catch (URISyntaxException error) {
            return null;
        }
    }

    private void showSetup() {
        cancelDeadlines();
        hideLoading();
        setup.setVisibility(View.VISIBLE);
        offline.setVisibility(View.GONE);
        web.stopLoading();
        content.setVisibility(View.GONE);
        address.setText(endpoint == null ? "" : endpoint.toString());
        address.setError(null);
        setup.setFocusableInTouchMode(true);
        setup.requestFocus();
    }

    private void saveAddress() {
        Uri newAddress = parseAddress(address.getText().toString());
        if (newAddress == null) {
            address.setError("请输入电脑窗口里的 Tailscale HTTPS 地址");
            return;
        }
        endpoint = newAddress;
        getPreferences(MODE_PRIVATE).edit().putString("address", endpoint.toString()).apply();
        InputMethodManager keyboard = (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
        if (keyboard != null) keyboard.hideSoftInputFromWindow(address.getWindowToken(), 0);
        connect("正在保存并连接…");
    }

    private static int port(Uri uri) {
        return uri.getPort() < 0 ? 443 : uri.getPort();
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private void connect() {
        connect("正在连接电脑…");
    }

    private void connect(String status) {
        failed = false;
        openedTailscale = false;
        cancelDeadlines();
        setup.setVisibility(View.GONE);
        offline.setVisibility(View.GONE);
        content.setVisibility(View.VISIBLE);
        showLoading(status);
        final long token = attempt;
        slowWait = new Runnable() {
            @Override public void run() {
                if (token != attempt) return;
                loadingLabel.setText("仍在等待电脑响应…请确认 Tailscale 已连接。");
            }
        };
        connectTimeout = new Runnable() {
            @Override public void run() {
                if (token != attempt) return;
                showOffline("连接超时：已等待超过 35 秒仍无响应。请确认 Tailscale 已连接，或更换电脑地址。");
            }
        };
        handler.postDelayed(slowWait, SLOW_WAIT_MS);
        handler.postDelayed(connectTimeout, CONNECT_TIMEOUT_MS);
        web.loadUrl(endpoint.toString());
    }

    private void showOffline() {
        showOffline(OFFLINE_NOTE);
    }

    private void showOffline(String message) {
        if (setup.getVisibility() == View.VISIBLE) return;
        failed = true;
        cancelDeadlines();
        hideLoading();
        offlineNote.setText(message);
        content.setVisibility(View.GONE);
        offline.setVisibility(View.VISIBLE);
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (openedTailscale && failed && setup.getVisibility() != View.VISIBLE) {
            connect();
        }
    }

    @Override
    public void onBackPressed() {
        if (endpoint != null && setup.getVisibility() == View.VISIBLE) {
            connect();
            return;
        }
        if (loading.getVisibility() == View.VISIBLE) {
            web.stopLoading();
            showOffline("已取消加载。请重新连接，或更换电脑地址。");
            return;
        }
        if (content.getVisibility() == View.VISIBLE) {
            web.evaluateJavascript(
                "(function(){ return window.__remotePanelBack ? window.__remotePanelBack() : false; })()",
                new ValueCallback<String>() {
                    @Override
                    public void onReceiveValue(String value) {
                        if (!"true".equals(value)) {
                            MainActivity.super.onBackPressed();
                        }
                    }
                }
            );
            return;
        }
        super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        cancelDeadlines();
        handler.removeCallbacksAndMessages(null);
        ((ViewGroup) web.getParent()).removeView(web);
        web.destroy();
        super.onDestroy();
    }
}
