package com.bysqh.guru.feature.settings.presentation.component

/*
 * [二开] 桌宠设置分区：开关 + 大小。
 * 机制与 VantaCode 的「偏好设置 → 桌宠」一致，尺寸做成可调（VantaCode 写死）。
 */

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.bysqh.guru.R
import com.bysqh.guru.core.theme.Spacing
import com.bysqh.guru.core.ui.AppSwitch
import com.bysqh.guru.feature.pet.data.PetSettingsRepository
import com.bysqh.guru.feature.pet.presentation.PetSettingsViewModel
import compose.icons.FeatherIcons
import compose.icons.feathericons.Smile

@Composable
internal fun PetSettingsSection(viewModel: PetSettingsViewModel) {
    val enabled by viewModel.enabled.collectAsStateWithLifecycle()
    val sizeDp by viewModel.sizeDp.collectAsStateWithLifecycle()

    // 滑块用 0~100 的百分比，映射到 MIN~MAX dp；本地状态保证拖动跟手。
    var sizePercent by remember(sizeDp) {
        mutableFloatStateOf(
            ((sizeDp - PetSettingsRepository.MIN_SIZE_DP) /
                (PetSettingsRepository.MAX_SIZE_DP - PetSettingsRepository.MIN_SIZE_DP)) * 100f
        )
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = Spacing.lg)
            .padding(bottom = Spacing.xl),
        verticalArrangement = Arrangement.spacedBy(Spacing.sm)
    ) {
        SettingsGroupHeader(text = stringResource(R.string.settings_pet_title))
        SettingsGroup {
            SettingsRow(
                icon = FeatherIcons.Smile,
                title = stringResource(R.string.settings_pet_enable),
                subtitle = stringResource(R.string.settings_pet_enable_desc),
                trailing = {
                    AppSwitch(
                        checked = enabled,
                        onCheckedChange = { viewModel.setEnabled(it) }
                    )
                }
            )
        }

        if (enabled) {
            SettingsGroup {
                Column(modifier = Modifier.padding(horizontal = Spacing.lg, vertical = Spacing.sm)) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Text(
                            text = stringResource(R.string.settings_pet_size),
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.weight(1f)
                        )
                        Text(
                            text = "${sizePercent.toInt()}%",
                            style = MaterialTheme.typography.bodyMedium,
                            fontWeight = FontWeight.SemiBold,
                            color = MaterialTheme.colorScheme.onSurface
                        )
                    }
                    Slider(
                        value = sizePercent,
                        onValueChange = { percent ->
                            sizePercent = percent
                            viewModel.setSizeDp(
                                PetSettingsRepository.MIN_SIZE_DP +
                                    (PetSettingsRepository.MAX_SIZE_DP - PetSettingsRepository.MIN_SIZE_DP) *
                                    (percent / 100f)
                            )
                        },
                        valueRange = 0f..100f
                    )
                    Text(
                        text = stringResource(R.string.settings_pet_size_hint),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(bottom = 4.dp)
                    )
                }
            }
        }
    }
}
