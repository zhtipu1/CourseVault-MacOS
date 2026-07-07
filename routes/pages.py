from flask import Blueprint, render_template, redirect, url_for
pages_bp = Blueprint("pages", __name__)

@pages_bp.route("/")
def index():
    return redirect(url_for("pages.library"))

@pages_bp.route("/library")
def library():
    return render_template("library.html", active_page="library")

@pages_bp.route("/course/<int:course_id>")
def course(course_id):
    return render_template("course.html", active_page="library", course_id=course_id)

@pages_bp.route("/player/<int:lesson_id>")
def player(lesson_id):
    return render_template("player.html", lesson_id=lesson_id)

@pages_bp.route("/manage/<int:course_id>")
def manage(course_id):
    return render_template("manage.html", active_page="library", course_id=course_id)

@pages_bp.route("/settings")
def settings():
    return render_template("settings.html", active_page="settings")

@pages_bp.route("/about")
def about():
    return render_template("about.html", active_page="about")
