package com.bysqh.guru.core.ui

import androidx.compose.material3.Checkbox
import androidx.compose.material3.CheckboxColors
import androidx.compose.material3.CheckboxDefaults
import androidx.compose.material3.RadioButton
import androidx.compose.material3.RadioButtonColors
import androidx.compose.material3.RadioButtonDefaults
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderColors
import androidx.compose.material3.SliderDefaults
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.state.ToggleableState
import com.bysqh.guru.core.theme.LocalUiStyle
import com.bysqh.guru.core.theme.UiStyle

/**
 * 全局统一复选框：参数与 Material3 [Checkbox] 一致，Miuix 界面样式下改用 miuix 的 Checkbox。
 *
 * miuix 的勾选态用 [ToggleableState]，且回调是点击而非新值，所以这里做一次翻转。
 */
@Composable
fun AppCheckbox(
    checked: Boolean,
    onCheckedChange: ((Boolean) -> Unit)?,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    colors: CheckboxColors = CheckboxDefaults.colors()
) {
    if (LocalUiStyle.current == UiStyle.MIUIX) {
        top.yukonga.miuix.kmp.basic.Checkbox(
            state = if (checked) ToggleableState.On else ToggleableState.Off,
            onClick = onCheckedChange?.let { change -> { change(!checked) } },
            modifier = modifier,
            enabled = enabled
        )
        return
    }
    Checkbox(
        checked = checked,
        onCheckedChange = onCheckedChange,
        modifier = modifier,
        enabled = enabled,
        colors = colors
    )
}

/** 全局统一单选框：参数与 Material3 [RadioButton] 一致，Miuix 下改用 miuix 的 RadioButton。 */
@Composable
fun AppRadioButton(
    selected: Boolean,
    onClick: (() -> Unit)?,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    colors: RadioButtonColors = RadioButtonDefaults.colors()
) {
    if (LocalUiStyle.current == UiStyle.MIUIX) {
        top.yukonga.miuix.kmp.basic.RadioButton(
            selected = selected,
            onClick = onClick,
            modifier = modifier,
            enabled = enabled
        )
        return
    }
    RadioButton(
        selected = selected,
        onClick = onClick,
        modifier = modifier,
        enabled = enabled,
        colors = colors
    )
}

/** 全局统一滑块：参数与 Material3 [Slider] 一致，Miuix 下改用 miuix 的 Slider。 */
@Composable
fun AppSlider(
    value: Float,
    onValueChange: (Float) -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    valueRange: ClosedFloatingPointRange<Float> = 0f..1f,
    steps: Int = 0,
    onValueChangeFinished: (() -> Unit)? = null,
    colors: SliderColors = SliderDefaults.colors()
) {
    if (LocalUiStyle.current == UiStyle.MIUIX) {
        top.yukonga.miuix.kmp.basic.Slider(
            value = value,
            onValueChange = onValueChange,
            modifier = modifier,
            enabled = enabled,
            valueRange = valueRange,
            steps = steps,
            onValueChangeFinished = onValueChangeFinished
        )
        return
    }
    Slider(
        value = value,
        onValueChange = onValueChange,
        modifier = modifier,
        enabled = enabled,
        valueRange = valueRange,
        steps = steps,
        onValueChangeFinished = onValueChangeFinished,
        colors = colors
    )
}
