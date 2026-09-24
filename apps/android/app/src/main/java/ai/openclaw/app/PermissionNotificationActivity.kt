package ai.openclaw.app

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.util.Log
import kotlinx.coroutines.TimeoutCancellationException

/** Only the app's immutable notification PendingIntent can enter this non-exported activity. */
class PermissionNotificationActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val permission = PhonePermission.entries.firstOrNull { it.name == intent.action }
    if (savedInstanceState == null && permission != null) {
      val app = application as NodeApp
      val required = intent.getStringArrayExtra("permissions")?.toList() ?: permission.permissions
      startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP))
      app.launchRuntimeTask {
        try {
          app.permissionRequester.request(permission, required)
          app.peekRuntime()?.refreshNodePermissionSurface()
        } catch (error: TimeoutCancellationException) {
          Log.d("OpenClawPermissions", "Permission request expired while opening the app", error)
        }
      }
    }
    finish()
  }
}
