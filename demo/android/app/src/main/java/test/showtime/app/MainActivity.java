package test.showtime.app;

import android.app.Activity;
import android.graphics.Color;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import java.text.SimpleDateFormat;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONArray;
import org.json.JSONObject;

/** ShowTime: a tiny movie-booking app. Screens are built in code; every control has a readable label. */
public class MainActivity extends Activity {
  private final ExecutorService io = Executors.newSingleThreadExecutor();
  private final Handler ui = new Handler(Looper.getMainLooper());
  private final ArrayDeque<Runnable> back = new ArrayDeque<>();
  private Api api;
  private LinearLayout root;
  private String cityId = "BLR";

  interface Load { JSONObject run() throws Exception; }
  interface Show { void run(JSONObject r) throws Exception; }

  @Override protected void onCreate(Bundle b) {
    super.onCreate(b);
    api = new Api(getSharedPreferences("showtime", MODE_PRIVATE));
    ScrollView sv = new ScrollView(this);
    root = new LinearLayout(this);
    root.setOrientation(LinearLayout.VERTICAL);
    root.setPadding(40, 60, 40, 40);
    sv.addView(root);
    setContentView(sv);
    io.execute(() -> { try { api.get("/v2/config"); } catch (Exception ignored) {} api.track("app_open", "launch"); });
    if (api.signedIn()) cities(); else login();
  }

  @Override public void onBackPressed() {
    // Drop the current screen, then re-open the previous one (which pushes itself again).
    if (back.size() > 1) { back.pop(); back.pop().run(); } else super.onBackPressed();
  }

  // Screens

  private void login() {
    screen("Log in", this::login);
    EditText email = input("Email", InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS | InputType.TYPE_CLASS_TEXT);
    EditText pass = input("Password", InputType.TYPE_TEXT_VARIATION_PASSWORD | InputType.TYPE_CLASS_TEXT);
    button("Log in", v -> load(() -> { api.login(email.getText().toString().trim(), pass.getText().toString()); return new JSONObject(); }, r -> { back.clear(); cities(); }));
  }

  private void cities() {
    screen("Choose your city", this::cities);
    load(() -> api.get("/v2/cities"), r -> {
      JSONArray a = r.getJSONArray("cities");
      for (int i = 0; i < a.length(); i++) {
        JSONObject c = a.getJSONObject(i);
        String id = c.getString("city_id");
        button(c.getString("name"), v -> { cityId = id; movies(); });
      }
      button("My bookings", v -> bookings());
    });
  }

  private void movies() {
    screen("Now showing", this::movies);
    load(() -> api.get("/v2/movies?city_id=" + cityId), r -> {
      JSONArray a = r.getJSONArray("items");
      for (int i = 0; i < a.length(); i++) {
        JSONObject m = a.getJSONObject(i);
        String id = m.getString("movie_id"), title = m.getString("title");
        button(title + "  (" + m.getString("rating") + ", " + m.getInt("runtime_min") + " min)", v -> dates(id, title));
      }
    });
  }

  private void dates(String movieId, String title) {
    screen(title, () -> dates(movieId, title));
    text("Pick a day");
    SimpleDateFormat f = new SimpleDateFormat("yyyy-MM-dd", Locale.US);
    String[] names = {"Today", "Tomorrow", "Day after"};
    for (int d = 0; d < 3; d++) {
      String date = f.format(new Date(System.currentTimeMillis() + d * 86400000L));
      button(names[d] + " (" + date + ")", v -> shows(movieId, title, date));
    }
  }

  private void shows(String movieId, String title, String date) {
    screen(title + " · " + date, () -> shows(movieId, title, date));
    load(() -> api.get("/v2/movies/" + movieId + "/shows?city_id=" + cityId + "&date=" + date), r -> {
      JSONArray a = r.getJSONArray("shows");
      if (a.length() == 0) text("No shows");
      for (int i = 0; i < a.length(); i++) {
        JSONObject s = a.getJSONObject(i);
        long showId = s.getLong("show_id");
        button(s.getString("theatre") + " · " + s.getString("starts_at") + " · ₹" + s.getInt("price_inr"), v -> seats(showId));
      }
    });
  }

  private void seats(long showId) {
    if (!api.signedIn()) { login(); return; }
    screen("Pick seats", () -> seats(showId));
    load(() -> api.get("/v2/shows/" + showId + "/seatmap"), r -> {
      text(r.getString("title") + " · " + r.getString("theatre") + " · " + r.getString("starts_at"));
      List<String> picked = new ArrayList<>();
      Button hold = new Button(this);
      JSONArray rows = r.getJSONArray("rows");
      for (int i = 0; i < rows.length(); i++) {
        JSONObject row = rows.getJSONObject(i);
        LinearLayout line = new LinearLayout(this);
        line.setGravity(Gravity.CENTER);
        JSONArray s = row.getJSONArray("seats");
        for (int k = 0; k < s.length(); k++) {
          JSONObject seat = s.getJSONObject(k);
          String id = seat.getString("seat_id");
          boolean free = seat.getString("status").equals("free");
          Button b = new Button(this);
          b.setText(id);
          b.setMinWidth(0); b.setMinimumWidth(0); b.setPadding(4, 4, 4, 4);
          b.setEnabled(free);
          b.setContentDescription("Seat " + id + (free ? " free" : " taken"));
          b.setOnClickListener(v -> {
            if (picked.remove(id)) { b.setBackgroundColor(Color.LTGRAY); b.setContentDescription("Seat " + id + " free"); }
            else { picked.add(id); b.setBackgroundColor(Color.rgb(15, 118, 110)); b.setContentDescription("Seat " + id + " selected"); }
            hold.setText("Hold " + picked.size() + " seat(s)");
          });
          line.addView(b, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1));
        }
        root.addView(line);
      }
      hold.setText("Hold 0 seat(s)");
      hold.setOnClickListener(v -> {
        if (picked.isEmpty()) { toast("Pick at least one seat"); return; }
        load(() -> api.post("/v2/shows/" + showId + "/hold", new JSONObject().put("seat_ids", new JSONArray(picked))), this::held);
      });
      root.addView(hold);
    });
  }

  private void held(JSONObject h) throws Exception {
    String holdId = h.getString("hold_id");
    screen("Seats held", () -> {});
    text("Seats " + h.getJSONArray("seats").join(", ").replace("\"", "") + " held for 10 minutes");
    text("Total ₹" + h.getInt("total_inr"));
    button("Proceed to pay", v -> load(() -> api.post("/v2/holds/" + holdId + "/checkout", null), r -> {
      screen("Payment", () -> {});
      text("Complete payment at:");
      text(r.getString("payment_url"));
      button("Done", x -> { back.clear(); cities(); });
    }));
  }

  private void bookings() {
    screen("My bookings", this::bookings);
    load(() -> api.get("/v2/me/bookings"), r -> {
      JSONArray a = r.getJSONArray("bookings");
      if (a.length() == 0) text("No bookings yet");
      for (int i = 0; i < a.length(); i++) {
        JSONObject b = a.getJSONObject(i);
        text("Show " + b.getLong("show_id") + " · " + b.getJSONArray("seats").join(", ").replace("\"", "") + " · " + b.getString("status"));
      }
    });
  }

  // Helpers

  private void screen(String title, Runnable self) {
    root.removeAllViews();
    if (back.isEmpty() || back.peek() != self) back.push(self);
    TextView t = new TextView(this);
    t.setText(title);
    t.setTextSize(24);
    t.setTextColor(Color.BLACK);
    t.setPadding(0, 0, 0, 24);
    root.addView(t);
    io.execute(() -> api.track("screen_view", title));
  }

  private void text(String s) {
    TextView t = new TextView(this);
    t.setText(s);
    t.setTextSize(16);
    t.setPadding(0, 8, 0, 8);
    root.addView(t);
  }

  private EditText input(String hint, int type) {
    EditText e = new EditText(this);
    e.setHint(hint);
    e.setContentDescription(hint);
    e.setInputType(type);
    root.addView(e);
    return e;
  }

  private void button(String label, View.OnClickListener l) {
    Button b = new Button(this);
    b.setText(label);
    b.setAllCaps(false);
    b.setOnClickListener(l);
    root.addView(b);
  }

  private void toast(String s) { android.widget.Toast.makeText(this, s, android.widget.Toast.LENGTH_SHORT).show(); }

  private void load(Load work, Show done) {
    io.execute(() -> {
      try {
        JSONObject r = work.run();
        ui.post(() -> { try { done.run(r); } catch (Exception e) { toast(e.getMessage()); } });
      } catch (Exception e) {
        ui.post(() -> { toast(e.getMessage()); if (!api.signedIn()) login(); });
      }
    });
  }
}
